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
    /// The schema metadata was missing the `rows`/`cols` shape keys.
    #[error("decode: missing '{0}' in schema metadata")]
    MissingShape(&'static str),
    /// A shape metadata value did not parse as a u32.
    #[error("decode: shape '{key}' = {value:?} is not a u32")]
    BadShape { key: &'static str, value: String },
    /// A column was absent or had the wrong Arrow type.
    #[error("decode: column {0} missing or wrong type")]
    BadColumn(&'static str),
    /// A `kind` discriminant was not one of the five known tags.
    #[error("decode: unknown kind {0:?}")]
    BadKind(String),
    /// An `error` cell carried a sigil that is not a known `ErrorValue`.
    #[error("decode: unknown error sigil {0:?}")]
    BadErrorSigil(String),
    /// The decoded cells did not match the declared shape.
    #[error("decode: shape mismatch ({0})")]
    ShapeMismatch(String),
}

const COL_KIND: usize = 0;
const COL_NUM: usize = 1;
const COL_STR: usize = 2;
const COL_BOOL: usize = 3;
const COL_ERR: usize = 4;

fn grid_schema(rows: u32, cols: u32) -> Schema {
    let fields = vec![
        Field::new("kind", DataType::Utf8, false),
        Field::new("num", DataType::Float64, true),
        Field::new("str", DataType::Utf8, true),
        Field::new("bool", DataType::Boolean, true),
        Field::new("err", DataType::Utf8, true),
    ];
    let metadata = HashMap::from([
        ("rows".to_string(), rows.to_string()),
        ("cols".to_string(), cols.to_string()),
    ]);
    Schema::new(fields).with_metadata(metadata)
}

/// Encode a grid to Arrow IPC stream bytes (the `CALL`/`RETURN` frame payload).
pub fn encode_grid(grid: &ArrayValue) -> Result<Vec<u8>, CodecError> {
    let rows = grid.rows();
    let cols = grid.cols();

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
    Ok(buf)
}

fn shape_from_metadata(md: &HashMap<String, String>, key: &'static str) -> Result<u32, CodecError> {
    let raw = md.get(key).ok_or(CodecError::MissingShape(key))?;
    raw.parse::<u32>().map_err(|_| CodecError::BadShape {
        key,
        value: raw.clone(),
    })
}

fn col<'a, T: Array + 'static>(batch: &'a RecordBatch, idx: usize, name: &'static str) -> Result<&'a T, CodecError> {
    batch
        .column(idx)
        .as_any()
        .downcast_ref::<T>()
        .ok_or(CodecError::BadColumn(name))
}

/// Decode Arrow IPC stream bytes (a `CALL`/`RETURN` frame payload) back to a grid.
pub fn decode_grid(bytes: &[u8]) -> Result<ArrayValue, CodecError> {
    let mut reader = StreamReader::try_new(std::io::Cursor::new(bytes), None)?;
    let batch = reader.next().ok_or(CodecError::Empty)??;

    let schema = batch.schema();
    let rows = shape_from_metadata(schema.metadata(), "rows")?;
    let cols = shape_from_metadata(schema.metadata(), "cols")?;

    let kind = col::<StringArray>(&batch, COL_KIND, "kind")?;
    let num = col::<Float64Array>(&batch, COL_NUM, "num")?;
    let text = col::<StringArray>(&batch, COL_STR, "str")?;
    let boolean = col::<BooleanArray>(&batch, COL_BOOL, "bool")?;
    let err = col::<StringArray>(&batch, COL_ERR, "err")?;

    let n = batch.num_rows();
    let expected = (rows as usize).saturating_mul(cols as usize);
    if n != expected {
        return Err(CodecError::ShapeMismatch(format!(
            "{n} cells but rows*cols = {expected} (rows={rows}, cols={cols})"
        )));
    }

    let mut cells = Vec::with_capacity(n);
    for i in 0..n {
        let v = match kind.value(i) {
            "blank" => Value::Blank,
            // Raw `Value::Number` (not the sanitizing constructor) to round-trip
            // the f64 bit pattern faithfully.
            "number" => Value::Number(num.value(i)),
            "bool" => Value::Boolean(boolean.value(i)),
            "text" => Value::Text(Arc::from(text.value(i))),
            "error" => {
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

    #[test]
    fn roundtrips_every_value_variant_in_one_grid() {
        // A 2×3 grid touching all five Value variants + a representative error.
        let cells = vec![
            Value::Blank,
            Value::Number(42.5),
            Value::Boolean(true),
            Value::Text(Arc::from("hello")),
            Value::Error(ErrorValue::DivZero),
            Value::Number(-0.0),
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
        // Value::Number — the engine sanitizes them to Error(Num) upstream).
        let mut cells = Vec::new();
        for i in 0..50u32 {
            cells.push(Value::Number(f64::from(i) * 1.5 - 12.25));
        }
        cells.push(Value::Number(f64::MAX));
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
        let batch =
            RecordBatch::try_new(schema.clone(), vec![kind, num, text, boolean, err]).unwrap();
        let mut buf = Vec::new();
        {
            let mut w = StreamWriter::try_new(&mut buf, &schema).unwrap();
            w.write(&batch).unwrap();
            w.finish().unwrap();
        }
        let e = decode_grid(&buf).unwrap_err();
        assert!(matches!(e, CodecError::BadKind(ref k) if k == "bogus"), "got {e:?}");
    }
}
