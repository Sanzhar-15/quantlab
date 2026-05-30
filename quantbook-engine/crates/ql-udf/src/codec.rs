//! Arrow ⇄ engine-`Value` codec — the wire payload for `CALL` / `RETURN` frames.
//!
//! **6.4-3a.** A UDF call's arguments and result are 2-D grids of spreadsheet
//! values ([`ql_types::ArrayValue`]); a scalar is just a 1×1 grid. This module
//! encodes a grid to Arrow IPC stream bytes and back.
//!
//! **Encoding (design §3 — the tagged columns).** Arrow has no native
//! spreadsheet-error type, so a value is encoded across five parallel columns of
//! length `rows*cols` (row-major), discriminated by `kind`:
//!
//! | kind     | populated column | engine `Value`            |
//! |----------|------------------|---------------------------|
//! | `blank`  | (none)           | `Value::Blank`            |
//! | `number` | `num: f64`       | `Value::Number`           |
//! | `bool`   | `bool: bool`     | `Value::Boolean`          |
//! | `text`   | `str: Utf8`      | `Value::Text`             |
//! | `error`  | `err: Utf8`      | `Value::Error` (by sigil) |
//!
//! The grid shape (`rows`, `cols`) rides in the Arrow schema metadata so degenerate
//! shapes (`rows==0` or `cols==0`, zero cells) round-trip faithfully. The encoding
//! is deliberately verbose-but-unambiguous; a compact layout is a later optimization
//! behind this same boundary.
//!
//! **Decode is a trust boundary (6.4-3a cycle-1 audit-fix).** The bytes a `RETURN`
//! frame carries are produced by an out-of-process Python worker — possibly buggy
//! or hostile. `decode_grid` therefore validates the batch BEFORE trusting it:
//! - the schema must be EXACTLY the 5 expected fields, by name + Arrow type +
//!   nullability, in order ([`validate_grid_schema`]) — so a `pyarrow` worker that
//!   reorders/renames columns is rejected loudly rather than silently mis-read (the
//!   two `Utf8` columns `str`/`err` are otherwise type-interchangeable);
//! - the active payload column for each `kind` must be non-null (a null active slot
//!   is a malformed response, not a silent `0.0`/`false`/`""`);
//! - a decoded `number` must be finite (`NaN`/`Inf` from the worker is a malformed
//!   result — the engine's `Value::Number` invariant is "always finite");
//! - the stream must contain EXACTLY one record batch (trailing data is rejected).
//!
//! No code path reachable from worker-controlled bytes may panic — every failure is
//! a loud [`CodecError`] (No-Fallbacks; design §5 / contract §10.4 exit tests 6+7).
//! `encode_grid` trusts its input (engine-resident `Value`s already satisfy the
//! finite-`Number` invariant); the validation above guards the untrusted *decode*
//! direction.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

use arrow::array::{
    Array, ArrayRef, BooleanArray, BooleanBuilder, Float64Array, Float64Builder, StringArray,
    StringBuilder,
};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::ipc::reader::StreamReader;
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;

use ql_types::{ArrayValue, ErrorValue, Value};

/// Failure to encode/decode a grid on the UDF wire. Every variant is loud — no
/// silent normalization (No-Fallbacks).
#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    /// Underlying Arrow IPC read/write error.
    #[error("arrow ipc: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
    /// The IPC stream contained no record batch.
    #[error("decode: empty IPC stream (expected exactly one record batch)")]
    Empty,
    /// The IPC stream contained MORE than one record batch (expected exactly one).
    #[error("decode: trailing data after the first record batch (expected exactly one)")]
    TrailingBatch,
    /// The batch schema was not the exact expected 5-field grid schema.
    #[error("decode: bad grid schema ({0})")]
    BadSchema(String),
    /// The schema metadata was missing the `rows`/`cols` shape keys.
    #[error("decode: missing '{0}' in schema metadata")]
    MissingShape(&'static str),
    /// A shape metadata value did not parse as a u32.
    #[error("decode: shape '{key}' = {value:?} is not a u32")]
    BadShape { key: &'static str, value: String },
    /// `rows * cols` overflowed `usize` (a hostile/garbage shape).
    #[error("decode: shape rows={rows} * cols={cols} overflows usize")]
    ShapeOverflow { rows: u32, cols: u32 },
    /// A column was absent or had the wrong Arrow type.
    #[error("decode: column {0} missing or wrong type")]
    BadColumn(&'static str),
    /// A `kind` discriminant was not one of the five known tags.
    #[error("decode: unknown kind {0:?}")]
    BadKind(String),
    /// The active payload column for a cell's `kind` was NULL (malformed response —
    /// reading it would silently coerce to `0.0`/`false`/`""`).
    #[error("decode: cell {row} has kind {kind:?} but its payload column is null")]
    NullPayload { row: usize, kind: String },
    /// A decoded `number` was non-finite (`NaN`/`Inf`) — out of the engine's
    /// `Value::Number` finite invariant; a malformed worker result.
    #[error("decode: cell {row} is a non-finite number ({value})")]
    NonFinite { row: usize, value: f64 },
    /// An `error` cell carried a sigil that is not a known `ErrorValue`.
    #[error("decode: unknown error sigil {0:?}")]
    BadErrorSigil(String),
    /// The decoded cells did not match the declared shape.
    #[error("decode: shape mismatch ({0})")]
    ShapeMismatch(String),
    /// A `CALL`/`RETURN` payload was shorter than its fixed `handle`/`call_id`
    /// header (6.4-3a audit-fix: typed payload framing — see [`crate::payload`]).
    #[error("decode: payload header truncated (need {need} bytes, got {got})")]
    ShortHeader { need: usize, got: usize },
    /// A control-frame string field ([`crate::control`]) was not valid UTF-8.
    #[error("decode: {field} field is not valid UTF-8")]
    BadUtf8 { field: &'static str },
    /// **6.4B (item I):** the grid's cell count (`rows * cols`) exceeds
    /// [`MAX_GRID_CELLS`]. Rejected loudly BEFORE allocating the cell vec — bounds
    /// both the engine-side `Vec<Value>` and the downstream spill.
    #[error("grid: {cells} cells exceeds the {max}-cell cap")]
    GridTooManyCells { cells: usize, max: usize },
    /// **6.4B (item I):** the encoded (or decoded-input) grid byte length exceeds
    /// [`MAX_GRID_BYTES`]. A coarse guard sized at the transport frame cap so a
    /// hostile grid is rejected here (a specific [`CodecError`]) rather than only
    /// at allocation. NOTE: it does NOT make a frame-layer rejection impossible —
    /// the frame payload is the grid PLUS a fixed header (8/16 bytes) PLUS the
    /// 1-byte type tag, so a grid within `(MAX_FRAME_LEN - 17, MAX_FRAME_LEN]`
    /// still trips [`crate::frame::MAX_FRAME_LEN`] (also fail-loud, just a less
    /// specific error). The frame layer remains the authoritative wire-size gate.
    #[error("grid: {bytes} bytes exceeds the {max}-byte cap")]
    GridTooManyBytes { bytes: usize, max: usize },
}

/// **6.4B (item I):** max cell count (`rows * cols`) of a UDF arg/return grid. A
/// larger grid is rejected as [`CodecError::GridTooManyCells`] rather than
/// allocated. Bounds the engine-side `Vec<Value>` and the spill that follows a UDF
/// array return. Generous (a full Excel column is ~1.05M cells; this admits ~5
/// columns of full height) but finite.
pub const MAX_GRID_CELLS: usize = 5_000_000;

/// **6.4B (item I):** max byte length of an encoded grid / decode input. Set to the
/// transport frame cap so `encode_grid` never yields a payload the frame writer
/// would reject, and a direct `decode_grid` of an over-cap buffer fails the same way.
pub const MAX_GRID_BYTES: usize = crate::frame::MAX_FRAME_LEN as usize;

const COL_KIND: usize = 0;
const COL_NUM: usize = 1;
const COL_STR: usize = 2;
const COL_BOOL: usize = 3;
const COL_ERR: usize = 4;

/// The exact field layout (name, type, nullability) the decoder requires. `kind`
/// is the non-null discriminant; the four payload columns are nullable (only the
/// one matching `kind` is populated per cell).
const EXPECTED_FIELDS: [(&str, DataType, bool); 5] = [
    ("kind", DataType::Utf8, false),
    ("num", DataType::Float64, true),
    ("str", DataType::Utf8, true),
    ("bool", DataType::Boolean, true),
    ("err", DataType::Utf8, true),
];

fn grid_schema(rows: u32, cols: u32) -> Schema {
    let fields: Vec<Field> = EXPECTED_FIELDS
        .iter()
        .map(|(name, dt, nullable)| Field::new(*name, dt.clone(), *nullable))
        .collect();
    let metadata = HashMap::from([
        ("rows".to_string(), rows.to_string()),
        ("cols".to_string(), cols.to_string()),
    ]);
    Schema::new(fields).with_metadata(metadata)
}

/// Encode a grid to Arrow IPC stream bytes (the `CALL`/`RETURN` frame payload).
/// Rejects a grid exceeding [`MAX_GRID_CELLS`] / [`MAX_GRID_BYTES`] (6.4B item I).
pub fn encode_grid(grid: &ArrayValue) -> Result<Vec<u8>, CodecError> {
    encode_grid_capped(grid, MAX_GRID_CELLS, MAX_GRID_BYTES)
}

/// [`encode_grid`] with explicit caps (the public wrapper passes the
/// [`MAX_GRID_CELLS`] / [`MAX_GRID_BYTES`] defaults). Split out so tests can drive
/// the cap paths with tiny limits instead of allocating a multi-million-cell grid.
fn encode_grid_capped(
    grid: &ArrayValue,
    max_cells: usize,
    max_bytes: usize,
) -> Result<Vec<u8>, CodecError> {
    let rows = grid.rows();
    let cols = grid.cols();

    // **6.4B (item I):** reject an over-cap arg grid (e.g. a huge range arg) BEFORE
    // building any Arrow buffers. `rows`/`cols` are `u32`; `checked_mul` guards the
    // 32-bit product overflowing `usize` on a hostile shape.
    let cell_count = (rows as usize)
        .checked_mul(cols as usize)
        .ok_or(CodecError::GridTooManyCells {
            cells: usize::MAX,
            max: max_cells,
        })?;
    if cell_count > max_cells {
        return Err(CodecError::GridTooManyCells {
            cells: cell_count,
            max: max_cells,
        });
    }

    let mut kind = StringBuilder::new();
    let mut num = Float64Builder::new();
    let mut text = StringBuilder::new();
    let mut boolean = BooleanBuilder::new();
    let mut err = StringBuilder::new();

    // Row-major, matching `ArrayValue`'s own cell ordering.
    for r in 0..rows {
        for c in 0..cols {
            let v = grid
                .get(r, c)
                .ok_or_else(|| CodecError::ShapeMismatch(format!("get({r},{c}) out of bounds")))?;
            match v {
                Value::Blank => {
                    kind.append_value("blank");
                    num.append_null();
                    text.append_null();
                    boolean.append_null();
                    err.append_null();
                }
                Value::Number(x) => {
                    kind.append_value("number");
                    num.append_value(*x);
                    text.append_null();
                    boolean.append_null();
                    err.append_null();
                }
                Value::Boolean(x) => {
                    kind.append_value("bool");
                    num.append_null();
                    text.append_null();
                    boolean.append_value(*x);
                    err.append_null();
                }
                Value::Text(t) => {
                    kind.append_value("text");
                    num.append_null();
                    text.append_value(t.as_ref());
                    boolean.append_null();
                    err.append_null();
                }
                Value::Error(e) => {
                    kind.append_value("error");
                    num.append_null();
                    text.append_null();
                    boolean.append_null();
                    err.append_value(e.sigil());
                }
            }
        }
    }

    let columns: Vec<ArrayRef> = vec![
        Arc::new(kind.finish()),
        Arc::new(num.finish()),
        Arc::new(text.finish()),
        Arc::new(boolean.finish()),
        Arc::new(err.finish()),
    ];
    let schema = Arc::new(grid_schema(rows, cols));
    let batch = RecordBatch::try_new(schema.clone(), columns)?;

    let mut buf = Vec::new();
    {
        let mut writer = StreamWriter::try_new(&mut buf, &schema)?;
        writer.write(&batch)?;
        writer.finish()?;
    }
    // **6.4B (item I):** a grid within the cell cap can still exceed the byte cap
    // via a few very large strings — reject here with a specific error rather than
    // letting the frame writer reject the payload with a generic length error.
    if buf.len() > max_bytes {
        return Err(CodecError::GridTooManyBytes {
            bytes: buf.len(),
            max: max_bytes,
        });
    }
    Ok(buf)
}

/// Validate that `schema` is EXACTLY the expected 5-field grid schema (each field's
/// name, type, and nullability, in order). Worker-controlled bytes are not trusted
/// to honor the column order/identity; a mismatch (reordered, renamed, retyped,
/// wrong count) is rejected loudly so positional column access below is sound and
/// the two `Utf8` columns (`str`/`err`) can never be silently swapped.
fn validate_grid_schema(schema: &Schema) -> Result<(), CodecError> {
    let fields = schema.fields();
    if fields.len() != EXPECTED_FIELDS.len() {
        return Err(CodecError::BadSchema(format!(
            "expected {} columns, got {}",
            EXPECTED_FIELDS.len(),
            fields.len()
        )));
    }
    for (idx, (name, dt, nullable)) in EXPECTED_FIELDS.iter().enumerate() {
        let f = &fields[idx];
        if f.name() != *name {
            return Err(CodecError::BadSchema(format!(
                "column {idx}: expected name {name:?}, got {:?}",
                f.name()
            )));
        }
        if f.data_type() != dt {
            return Err(CodecError::BadSchema(format!(
                "column {idx} ({name:?}): expected type {dt:?}, got {:?}",
                f.data_type()
            )));
        }
        if f.is_nullable() != *nullable {
            return Err(CodecError::BadSchema(format!(
                "column {idx} ({name:?}): expected nullable={nullable}, got {}",
                f.is_nullable()
            )));
        }
    }
    Ok(())
}

fn shape_from_metadata(md: &HashMap<String, String>, key: &'static str) -> Result<u32, CodecError> {
    let raw = md.get(key).ok_or(CodecError::MissingShape(key))?;
    raw.parse::<u32>().map_err(|_| CodecError::BadShape {
        key,
        value: raw.clone(),
    })
}

fn col<'a, T: Array + 'static>(
    batch: &'a RecordBatch,
    idx: usize,
    name: &'static str,
) -> Result<&'a T, CodecError> {
    // `idx` is in-bounds: `validate_grid_schema` has already asserted exactly 5
    // columns, so `batch.column(idx)` for idx in 0..5 cannot panic.
    batch
        .column(idx)
        .as_any()
        .downcast_ref::<T>()
        .ok_or(CodecError::BadColumn(name))
}

/// Decode Arrow IPC stream bytes (a `CALL`/`RETURN` frame payload) back to a grid.
///
/// Every failure mode for worker-controlled bytes is a loud [`CodecError`] — no
/// reachable panic, no silent coercion (No-Fallbacks; design §5).
pub fn decode_grid(bytes: &[u8]) -> Result<ArrayValue, CodecError> {
    decode_grid_capped(bytes, MAX_GRID_CELLS, MAX_GRID_BYTES)
}

/// [`decode_grid`] with explicit caps (the public wrapper passes the
/// [`MAX_GRID_CELLS`] / [`MAX_GRID_BYTES`] defaults). Split out so tests can drive
/// the cap paths with tiny limits instead of decoding a multi-million-cell grid.
fn decode_grid_capped(
    bytes: &[u8],
    max_cells: usize,
    max_bytes: usize,
) -> Result<ArrayValue, CodecError> {
    // **6.4B (item I):** reject an over-cap input buffer up front (defense in depth
    // — the transport frame layer already caps reads at `MAX_FRAME_LEN`, but a
    // direct `decode_grid` of in-memory bytes does not pass through it).
    if bytes.len() > max_bytes {
        return Err(CodecError::GridTooManyBytes {
            bytes: bytes.len(),
            max: max_bytes,
        });
    }
    let mut reader = StreamReader::try_new(std::io::Cursor::new(bytes), None)?;
    let batch = reader.next().ok_or(CodecError::Empty)??;

    // Exactly one batch: a worker writing extra batches into one frame is malformed.
    if reader.next().is_some() {
        return Err(CodecError::TrailingBatch);
    }

    let schema = batch.schema();
    // Validate the schema BEFORE any positional column access (so `col()` indexing
    // is sound) and BEFORE trusting column identity (the `Utf8` `str`/`err` columns
    // are otherwise indistinguishable by type).
    validate_grid_schema(&schema)?;

    let rows = shape_from_metadata(schema.metadata(), "rows")?;
    let cols = shape_from_metadata(schema.metadata(), "cols")?;

    let kind = col::<StringArray>(&batch, COL_KIND, "kind")?;
    let num = col::<Float64Array>(&batch, COL_NUM, "num")?;
    let text = col::<StringArray>(&batch, COL_STR, "str")?;
    let boolean = col::<BooleanArray>(&batch, COL_BOOL, "bool")?;
    let err = col::<StringArray>(&batch, COL_ERR, "err")?;

    let n = batch.num_rows();
    // `checked_mul` (matching `ArrayValue::new`) — a hostile shape that overflows is
    // a loud error, not a silent saturation that happens to disagree with `n`.
    let expected = (rows as usize)
        .checked_mul(cols as usize)
        .ok_or(CodecError::ShapeOverflow { rows, cols })?;
    if n != expected {
        return Err(CodecError::ShapeMismatch(format!(
            "{n} cells but rows*cols = {expected} (rows={rows}, cols={cols})"
        )));
    }

    // **6.4B (item I):** reject an over-cap grid BEFORE the `Vec::with_capacity(n)`
    // allocation below — a worker returning a legitimately-shaped but enormous grid
    // (within the byte cap) is a visible `#VALUE!`, not a multi-million-element alloc.
    if n > max_cells {
        return Err(CodecError::GridTooManyCells {
            cells: n,
            max: max_cells,
        });
    }

    let mut cells = Vec::with_capacity(n);
    for i in 0..n {
        // `kind` is non-nullable per the validated schema; an empty/garbage tag
        // falls through to `BadKind` below rather than panicking.
        let v = match kind.value(i) {
            "blank" => Value::Blank,
            "number" => {
                if num.is_null(i) {
                    return Err(CodecError::NullPayload {
                        row: i,
                        kind: "number".to_string(),
                    });
                }
                let x = num.value(i);
                // The engine's `Value::Number` invariant is "always finite"; a
                // `NaN`/`Inf` from the worker is a malformed result (it would
                // otherwise poison equality/dirty-tracking downstream).
                if !x.is_finite() {
                    return Err(CodecError::NonFinite { row: i, value: x });
                }
                Value::Number(x)
            }
            "bool" => {
                if boolean.is_null(i) {
                    return Err(CodecError::NullPayload {
                        row: i,
                        kind: "bool".to_string(),
                    });
                }
                Value::Boolean(boolean.value(i))
            }
            "text" => {
                if text.is_null(i) {
                    return Err(CodecError::NullPayload {
                        row: i,
                        kind: "text".to_string(),
                    });
                }
                Value::Text(Arc::from(text.value(i)))
            }
            "error" => {
                if err.is_null(i) {
                    return Err(CodecError::NullPayload {
                        row: i,
                        kind: "error".to_string(),
                    });
                }
                let sigil = err.value(i);
                let ev = ErrorValue::from_str(sigil)
                    .map_err(|_| CodecError::BadErrorSigil(sigil.to_string()))?;
                Value::Error(ev)
            }
            other => return Err(CodecError::BadKind(other.to_string())),
        };
        cells.push(v);
    }

    ArrayValue::new(rows, cols, cells)
        .map_err(|e| CodecError::ShapeMismatch(format!("ArrayValue::new: {e:?}")))
}

/// Convenience: encode a single scalar as a 1×1 grid (a UDF returning a scalar).
pub fn encode_scalar(value: Value) -> Result<Vec<u8>, CodecError> {
    encode_grid(&ArrayValue::singleton(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(grid: &ArrayValue) -> ArrayValue {
        let bytes = encode_grid(grid).expect("encode");
        decode_grid(&bytes).expect("decode")
    }

    fn assert_roundtrip(grid: ArrayValue) {
        let back = roundtrip(&grid);
        assert_eq!(back.rows(), grid.rows(), "rows");
        assert_eq!(back.cols(), grid.cols(), "cols");
        for r in 0..grid.rows() {
            for c in 0..grid.cols() {
                assert_eq!(back.get(r, c), grid.get(r, c), "cell ({r},{c})");
            }
        }
    }

    /// Write a hand-built (schema, columns) pair to IPC stream bytes — for the
    /// adversarial decode tests that fabricate malformed worker output.
    fn write_ipc(schema: &Arc<Schema>, columns: Vec<ArrayRef>) -> Vec<u8> {
        let batch = RecordBatch::try_new(schema.clone(), columns).unwrap();
        let mut buf = Vec::new();
        let mut w = StreamWriter::try_new(&mut buf, schema).unwrap();
        w.write(&batch).unwrap();
        w.finish().unwrap();
        buf
    }

    #[test]
    fn roundtrips_every_value_variant_in_one_grid() {
        // A 2×3 grid touching all five Value variants + a representative error.
        let cells = vec![
            Value::Blank,
            Value::Number(42.5),
            Value::Boolean(true),
            Value::Text(Arc::from("hello")),
            Value::Error(ErrorValue::DivZero),
            Value::Number(-1.5),
        ];
        assert_roundtrip(ArrayValue::new(2, 3, cells).unwrap());
    }

    #[test]
    fn roundtrips_scalar() {
        assert_roundtrip(ArrayValue::singleton(Value::Number(12.5)));
        assert_roundtrip(ArrayValue::singleton(Value::Text(Arc::from(""))));
        assert_roundtrip(ArrayValue::singleton(Value::Boolean(false)));
        assert_roundtrip(ArrayValue::singleton(Value::Blank));
    }

    /// **6.4-3a audit-fix (L1):** `-0.0` must survive bit-for-bit. Derived `Value`
    /// equality compares `-0.0 == 0.0` true, so `assert_roundtrip` alone would pass
    /// even on a sign flip — assert the raw bits to actually pin sign preservation.
    #[test]
    fn negative_zero_round_trips_bit_for_bit() {
        let bytes = encode_scalar(Value::Number(-0.0)).unwrap();
        let back = decode_grid(&bytes).unwrap();
        match back.get(0, 0) {
            Some(Value::Number(x)) => {
                assert_eq!(x.to_bits(), (-0.0f64).to_bits(), "sign bit lost");
            }
            other => panic!("expected Number(-0.0), got {other:?}"),
        }
    }

    #[test]
    fn roundtrips_all_15_error_sigils() {
        // Every ErrorValue variant must survive the sigil ↔ from_str round trip.
        let errors = [
            ErrorValue::Ref,
            ErrorValue::Value,
            ErrorValue::NA,
            ErrorValue::DivZero,
            ErrorValue::Null,
            ErrorValue::Num,
            ErrorValue::Name,
            ErrorValue::Spill,
            ErrorValue::Calc,
            ErrorValue::Disconnected,
            ErrorValue::Binding,
            ErrorValue::Timeout,
            ErrorValue::Permission,
            ErrorValue::AINotAvailable,
            ErrorValue::Circ,
        ];
        let cells: Vec<Value> = errors.iter().copied().map(Value::Error).collect();
        let n = cells.len() as u32;
        assert_roundtrip(ArrayValue::new(n, 1, cells).unwrap());
    }

    #[test]
    fn roundtrips_degenerate_empty_shapes() {
        // rows>0, cols==0 (zero cells) and the fully-empty case must preserve shape.
        assert_roundtrip(ArrayValue::empty(3, 0));
        assert_roundtrip(ArrayValue::empty(0, 0));
        assert_roundtrip(ArrayValue::empty(0, 4));
    }

    #[test]
    fn roundtrips_large_numeric_grid_and_extremes() {
        // Finite f64 extremes round-trip exactly (NaN/Inf are out-of-contract for
        // Value::Number — `decode_grid` REJECTS them; see `decode_rejects_*` below).
        let mut cells = Vec::new();
        for i in 0..50u32 {
            cells.push(Value::Number(f64::from(i) * 1.5 - 12.25));
        }
        cells.push(Value::Number(f64::MAX));
        cells.push(Value::Number(f64::MIN));
        cells.push(Value::Number(f64::MIN_POSITIVE));
        let n = cells.len() as u32;
        assert_roundtrip(ArrayValue::new(n, 1, cells).unwrap());
    }

    #[test]
    fn decode_rejects_unknown_kind_loudly() {
        // Hand-build a batch with a bogus kind → decode must error, not silently coerce.
        let schema = Arc::new(grid_schema(1, 1));
        let kind = Arc::new(StringArray::from(vec!["bogus"])) as ArrayRef;
        let num = Arc::new(Float64Array::from(vec![None as Option<f64>])) as ArrayRef;
        let text = Arc::new(StringArray::from(vec![None as Option<&str>])) as ArrayRef;
        let boolean = Arc::new(BooleanArray::from(vec![None as Option<bool>])) as ArrayRef;
        let err = Arc::new(StringArray::from(vec![None as Option<&str>])) as ArrayRef;
        let buf = write_ipc(&schema, vec![kind, num, text, boolean, err]);
        let e = decode_grid(&buf).unwrap_err();
        assert!(matches!(e, CodecError::BadKind(ref k) if k == "bogus"), "got {e:?}");
    }

    /// **6.4-3a audit-fix (H1):** a batch with FEWER than 5 columns must error, not
    /// panic. Pre-fix `decode_grid` did `batch.column(1..4)` which panics out of
    /// bounds (arrow `RecordBatch::column` is a slice index).
    #[test]
    fn decode_rejects_short_column_set_without_panicking() {
        // A single `kind` column + the shape metadata — would have panicked at
        // `batch.column(1)`.
        let one_field =
            Schema::new(vec![Field::new("kind", DataType::Utf8, false)]).with_metadata(
                HashMap::from([("rows".into(), "1".into()), ("cols".into(), "1".into())]),
            );
        let schema = Arc::new(one_field);
        let kind = Arc::new(StringArray::from(vec!["blank"])) as ArrayRef;
        let buf = write_ipc(&schema, vec![kind]);
        let e = decode_grid(&buf).unwrap_err();
        assert!(
            matches!(e, CodecError::BadSchema(_)),
            "short column set must be BadSchema, got {e:?}"
        );
    }

    /// **6.4-3a audit-fix (H2):** a reordered schema (the two `Utf8` columns
    /// `str`/`err` swapped — type-compatible, so the OLD positional decode would
    /// have silently mis-read sigils as text) must be rejected.
    #[test]
    fn decode_rejects_reordered_schema() {
        // Fields in order kind, num, ERR, bool, STR (str<->err swapped by name).
        let fields = vec![
            Field::new("kind", DataType::Utf8, false),
            Field::new("num", DataType::Float64, true),
            Field::new("err", DataType::Utf8, true), // was "str"
            Field::new("bool", DataType::Boolean, true),
            Field::new("str", DataType::Utf8, true), // was "err"
        ];
        let schema = Arc::new(Schema::new(fields).with_metadata(HashMap::from([
            ("rows".into(), "1".into()),
            ("cols".into(), "1".into()),
        ])));
        let kind = Arc::new(StringArray::from(vec!["text"])) as ArrayRef;
        let num = Arc::new(Float64Array::from(vec![None as Option<f64>])) as ArrayRef;
        let c2 = Arc::new(StringArray::from(vec![Some("#REF!")])) as ArrayRef;
        let boolean = Arc::new(BooleanArray::from(vec![None as Option<bool>])) as ArrayRef;
        let c4 = Arc::new(StringArray::from(vec![Some("hi")])) as ArrayRef;
        let buf = write_ipc(&schema, vec![kind, num, c2, boolean, c4]);
        let e = decode_grid(&buf).unwrap_err();
        assert!(
            matches!(e, CodecError::BadSchema(_)),
            "reordered schema must be BadSchema, got {e:?}"
        );
    }

    /// **6.4-3a audit-fix (null-slot coercion):** `kind="number"` with a NULL `num`
    /// slot must error, not silently decode to `0.0`.
    #[test]
    fn decode_rejects_null_active_payload() {
        let schema = Arc::new(grid_schema(1, 1));
        let kind = Arc::new(StringArray::from(vec!["number"])) as ArrayRef;
        let num = Arc::new(Float64Array::from(vec![None as Option<f64>])) as ArrayRef; // NULL!
        let text = Arc::new(StringArray::from(vec![None as Option<&str>])) as ArrayRef;
        let boolean = Arc::new(BooleanArray::from(vec![None as Option<bool>])) as ArrayRef;
        let err = Arc::new(StringArray::from(vec![None as Option<&str>])) as ArrayRef;
        let buf = write_ipc(&schema, vec![kind, num, text, boolean, err]);
        let e = decode_grid(&buf).unwrap_err();
        assert!(
            matches!(e, CodecError::NullPayload { row: 0, .. }),
            "null active payload must be NullPayload, got {e:?}"
        );
    }

    /// **6.4-3a audit-fix (nan-inf-leak):** a worker returning `NaN`/`Inf` must be
    /// rejected, not passed through as an unsanitized `Value::Number`.
    #[test]
    fn decode_rejects_non_finite_number() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let schema = Arc::new(grid_schema(1, 1));
            let kind = Arc::new(StringArray::from(vec!["number"])) as ArrayRef;
            let num = Arc::new(Float64Array::from(vec![Some(bad)])) as ArrayRef;
            let text = Arc::new(StringArray::from(vec![None as Option<&str>])) as ArrayRef;
            let boolean = Arc::new(BooleanArray::from(vec![None as Option<bool>])) as ArrayRef;
            let err = Arc::new(StringArray::from(vec![None as Option<&str>])) as ArrayRef;
            let buf = write_ipc(&schema, vec![kind, num, text, boolean, err]);
            let e = decode_grid(&buf).unwrap_err();
            assert!(
                matches!(e, CodecError::NonFinite { row: 0, .. }),
                "non-finite {bad} must be NonFinite, got {e:?}"
            );
        }
    }

    /// **6.4-3a audit-fix (bad error sigil decode path — previously untested):** an
    /// `error` cell carrying an unknown sigil must surface `BadErrorSigil`.
    #[test]
    fn decode_rejects_unknown_error_sigil() {
        let schema = Arc::new(grid_schema(1, 1));
        let kind = Arc::new(StringArray::from(vec!["error"])) as ArrayRef;
        let num = Arc::new(Float64Array::from(vec![None as Option<f64>])) as ArrayRef;
        let text = Arc::new(StringArray::from(vec![None as Option<&str>])) as ArrayRef;
        let boolean = Arc::new(BooleanArray::from(vec![None as Option<bool>])) as ArrayRef;
        let err = Arc::new(StringArray::from(vec![Some("#NOT_A_REAL_SIGIL!")])) as ArrayRef;
        let buf = write_ipc(&schema, vec![kind, num, text, boolean, err]);
        let e = decode_grid(&buf).unwrap_err();
        assert!(
            matches!(e, CodecError::BadErrorSigil(ref s) if s == "#NOT_A_REAL_SIGIL!"),
            "got {e:?}"
        );
    }

    /// **6.4-3a audit-fix (shape metadata — previously untested):** missing
    /// `rows`/`cols` metadata, non-u32 metadata, and a metadata-vs-cell-count
    /// mismatch must all error.
    #[test]
    fn decode_rejects_bad_shape_metadata() {
        // (a) missing metadata entirely.
        let fields: Vec<Field> = EXPECTED_FIELDS
            .iter()
            .map(|(n, dt, nl)| Field::new(*n, dt.clone(), *nl))
            .collect();
        let no_md = Arc::new(Schema::new(fields)); // no .with_metadata
        let cols0: Vec<ArrayRef> = vec![
            Arc::new(StringArray::from(vec!["blank"])),
            Arc::new(Float64Array::from(vec![None as Option<f64>])),
            Arc::new(StringArray::from(vec![None as Option<&str>])),
            Arc::new(BooleanArray::from(vec![None as Option<bool>])),
            Arc::new(StringArray::from(vec![None as Option<&str>])),
        ];
        let buf = write_ipc(&no_md, cols0);
        assert!(
            matches!(decode_grid(&buf).unwrap_err(), CodecError::MissingShape(_)),
            "missing metadata must be MissingShape"
        );

        // (b) non-u32 metadata.
        let bad_md = {
            let fields: Vec<Field> = EXPECTED_FIELDS
                .iter()
                .map(|(n, dt, nl)| Field::new(*n, dt.clone(), *nl))
                .collect();
            Arc::new(Schema::new(fields).with_metadata(HashMap::from([
                ("rows".into(), "abc".into()),
                ("cols".into(), "1".into()),
            ])))
        };
        let cols1: Vec<ArrayRef> = vec![
            Arc::new(StringArray::from(vec!["blank"])),
            Arc::new(Float64Array::from(vec![None as Option<f64>])),
            Arc::new(StringArray::from(vec![None as Option<&str>])),
            Arc::new(BooleanArray::from(vec![None as Option<bool>])),
            Arc::new(StringArray::from(vec![None as Option<&str>])),
        ];
        let buf = write_ipc(&bad_md, cols1);
        assert!(
            matches!(decode_grid(&buf).unwrap_err(), CodecError::BadShape { .. }),
            "non-u32 metadata must be BadShape"
        );

        // (c) metadata says 2×2 (=4 cells) but the batch has 1 row.
        let mismatch = Arc::new(grid_schema(2, 2));
        let cols2: Vec<ArrayRef> = vec![
            Arc::new(StringArray::from(vec!["blank"])),
            Arc::new(Float64Array::from(vec![None as Option<f64>])),
            Arc::new(StringArray::from(vec![None as Option<&str>])),
            Arc::new(BooleanArray::from(vec![None as Option<bool>])),
            Arc::new(StringArray::from(vec![None as Option<&str>])),
        ];
        let buf = write_ipc(&mismatch, cols2);
        assert!(
            matches!(decode_grid(&buf).unwrap_err(), CodecError::ShapeMismatch(_)),
            "cell-count mismatch must be ShapeMismatch"
        );
    }

    /// **6.4-3a audit-fix (extra-batches-dropped):** a stream with more than one
    /// record batch must be rejected, matching the "exactly one" doc contract.
    #[test]
    fn decode_rejects_trailing_batch() {
        let schema = Arc::new(grid_schema(1, 1));
        let make_cols = || -> Vec<ArrayRef> {
            vec![
                Arc::new(StringArray::from(vec!["blank"])),
                Arc::new(Float64Array::from(vec![None as Option<f64>])),
                Arc::new(StringArray::from(vec![None as Option<&str>])),
                Arc::new(BooleanArray::from(vec![None as Option<bool>])),
                Arc::new(StringArray::from(vec![None as Option<&str>])),
            ]
        };
        let mut buf = Vec::new();
        {
            let mut w = StreamWriter::try_new(&mut buf, &schema).unwrap();
            w.write(&RecordBatch::try_new(schema.clone(), make_cols()).unwrap())
                .unwrap();
            w.write(&RecordBatch::try_new(schema.clone(), make_cols()).unwrap())
                .unwrap();
            w.finish().unwrap();
        }
        assert!(
            matches!(decode_grid(&buf).unwrap_err(), CodecError::TrailingBatch),
            "two batches must be TrailingBatch"
        );
    }

    #[test]
    fn decode_rejects_empty_stream() {
        // A schema-only stream (no batches) → Empty.
        let schema = Arc::new(grid_schema(0, 0));
        let mut buf = Vec::new();
        {
            let mut w = StreamWriter::try_new(&mut buf, &schema).unwrap();
            w.finish().unwrap();
        }
        assert!(matches!(decode_grid(&buf).unwrap_err(), CodecError::Empty));
    }

    // ---- 6.4B (item I): grid resource caps ----

    /// `encode_grid_capped` rejects a grid whose cell count exceeds the cap BEFORE
    /// building Arrow buffers (a tiny cap stands in for the 5M default so the test
    /// allocates nothing large).
    #[test]
    fn encode_rejects_grid_over_cell_cap() {
        let grid = ArrayValue::new(2, 2, vec![Value::Number(1.0); 4]).unwrap();
        let err = encode_grid_capped(&grid, 3, MAX_GRID_BYTES).unwrap_err();
        assert!(
            matches!(err, CodecError::GridTooManyCells { cells: 4, max: 3 }),
            "got {err:?}"
        );
        // At the cap it still encodes.
        assert!(encode_grid_capped(&grid, 4, MAX_GRID_BYTES).is_ok());
    }

    /// `decode_grid_capped` rejects an over-cap grid BEFORE the cell-vec allocation.
    #[test]
    fn decode_rejects_grid_over_cell_cap() {
        let grid = ArrayValue::new(2, 2, vec![Value::Number(7.0); 4]).unwrap();
        let bytes = encode_grid(&grid).expect("encode (under default cap)");
        let err = decode_grid_capped(&bytes, 3, MAX_GRID_BYTES).unwrap_err();
        assert!(
            matches!(err, CodecError::GridTooManyCells { cells: 4, max: 3 }),
            "got {err:?}"
        );
        // At the cap it round-trips.
        let back = decode_grid_capped(&bytes, 4, MAX_GRID_BYTES).expect("decode at cap");
        assert_eq!(back.rows(), 2);
        assert_eq!(back.cols(), 2);
    }

    /// `encode_grid_capped` rejects a grid whose ENCODED bytes exceed the byte cap
    /// even when its cell count is under the cell cap (few cells, large strings).
    #[test]
    fn encode_rejects_grid_over_byte_cap() {
        let big = "x".repeat(4096);
        let grid = ArrayValue::new(1, 1, vec![Value::Text(Arc::from(big.as_str()))]).unwrap();
        let err = encode_grid_capped(&grid, MAX_GRID_CELLS, 64).unwrap_err();
        assert!(
            matches!(err, CodecError::GridTooManyBytes { max: 64, .. }),
            "got {err:?}"
        );
    }

    /// `decode_grid_capped` rejects an over-cap input buffer up front (defense in
    /// depth beyond the transport frame cap).
    #[test]
    fn decode_rejects_input_over_byte_cap() {
        let grid = ArrayValue::new(1, 1, vec![Value::Number(1.0)]).unwrap();
        let bytes = encode_grid(&grid).expect("encode");
        let err = decode_grid_capped(&bytes, MAX_GRID_CELLS, 8).unwrap_err();
        assert!(
            matches!(err, CodecError::GridTooManyBytes { max: 8, .. }),
            "got {err:?}"
        );
    }
}
