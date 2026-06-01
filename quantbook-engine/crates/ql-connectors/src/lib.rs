//! `ql-connectors` — external dataset connector surface (Phase 6.5-3).
//!
//! Uniform credentials-aware [`DataSource`] trait with two v1 local-file
//! connectors: [`CsvDataSource`] (CONN-6-01, wraps `ql-io-csv`) and
//! [`ParquetDataSource`] (Parquet via the `arrow`/`parquet` 58.x family already
//! in the workspace). Connectors register as refreshable sources via the default
//! [`DataSource::refresh`] blanket. Errors surface loudly — no silent fallbacks
//! (CONN-6-02, No-Fallbacks card).

#![forbid(unsafe_code)]

use std::fs;
use std::path::PathBuf;

use arrow_array::Array;
use arrow_schema::DataType;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use ql_io_csv::{import_csv_bytes, CsvImportOptions};
use ql_storage::Workbook;
use ql_types::{ColId, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
use thiserror::Error;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// Credential bundle threaded through every [`DataSource`] call.
///
/// Local-file connectors do not use credentials; future network connectors
/// (Postgres, S3, API keys) will use `token` and additional fields. The struct
/// is `#[non_exhaustive]` so adding fields is not a breaking change for callers
/// that construct it via `Default` or `Credentials { token: None, ..Default::default() }`.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct Credentials {
    /// Bearer token / API key for network data sources. Ignored by local-file
    /// connectors.
    pub token: Option<String>,
}

// Manual, REDACTED `Debug` (6.7 audit C-M1): the derived `Debug` would print the
// secret `token`, leaking it into any log line / error chain / panic message that
// formats a `Credentials`. Local connectors ignore the token today, but a redacted
// `Debug` closes the disclosure path before network connectors (v1.5) carry a real
// secret here. Print only PRESENCE, never the value.
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field(
                "token",
                &self.token.as_ref().map(|_| "<redacted>"),
            )
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/// Error type for all connector operations.
///
/// `#[non_exhaustive]` — downstream `match` must carry a wildcard arm; the
/// owning engine maps unknown variants to a loud `unmapped_connector_error`
/// rather than a silent default (No-Fallbacks).
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ConnectorError {
    /// File-system I/O failure (file not found, permissions, OS error).
    #[error("connector '{source_id}' I/O error: {source}")]
    Io {
        source_id: String,
        #[source]
        source: std::io::Error,
    },

    /// CSV parse / import failure (UTF-8, framing, sheet-limits overflow).
    #[error("connector '{source_id}' CSV error: {source}")]
    Csv {
        source_id: String,
        #[source]
        source: ql_io_csv::CsvError,
    },

    /// Parquet read failure (corrupt magic, unsupported encoding, Arrow
    /// conversion error).
    #[error("connector '{source_id}' Parquet error: {source}")]
    Parquet {
        source_id: String,
        #[source]
        source: parquet::errors::ParquetError,
    },

    /// The source file is larger than the engine's addressable sheet extent
    /// (`MAX_ROW` × `MAX_COLUMN`). Fails loud before any storage mutation.
    #[error("connector '{source_id}': data exceeds engine sheet limits -- {detail}")]
    ExceedsLimits { source_id: String, detail: String },

    /// A Parquet column has an Arrow type not supported by the v1 connector
    /// (e.g. Date32, Timestamp, Decimal, Binary, Dictionary). No partial data
    /// is silently stored — the whole load fails loud (No-Fallbacks, CONN-6-02).
    /// Convert the column to a supported type before loading, or open a
    /// connector extension request for a v1.x conversion.
    #[error(
        "connector '{source_id}' unsupported Arrow column type '{arrow_type}' -- \
         v1 supports Boolean, integer, float, and Utf8; convert the column or \
         file a v1.x extension request"
    )]
    UnsupportedArrowType { source_id: String, arrow_type: String },
}

// ---------------------------------------------------------------------------
// DataSource trait
// ---------------------------------------------------------------------------

/// Uniform interface for refreshable external data sources.
///
/// `load` reads the source in full and returns a fresh single-sheet workbook
/// (`"Sheet1"`). `refresh` defaults to a full re-load; v1.5+ connectors (e.g.
/// an incremental Postgres cursor) may override it for revision-gated semantics.
///
/// Both methods take `&self` so connectors can be held in `Arc<dyn DataSource>`
/// and called concurrently across refresh tasks.
pub trait DataSource: Send + Sync {
    /// Stable, unique identifier used in provenance records and error messages.
    fn source_id(&self) -> &str;

    /// Load all rows from the external source, returning a fresh workbook.
    ///
    /// Any I/O, parse, or engine-limit error must surface as a
    /// [`ConnectorError`] — never silently yield an empty or partial result.
    fn load(&self, credentials: &Credentials) -> Result<Workbook, ConnectorError>;

    /// Re-fetch the source (used by `refresh_source`). Default: full re-load.
    fn refresh(&self, credentials: &Credentials) -> Result<Workbook, ConnectorError> {
        self.load(credentials)
    }
}

// ---------------------------------------------------------------------------
// CSV connector — CONN-6-01
// ---------------------------------------------------------------------------

/// Local-file CSV connector. Delegates to [`ql_io_csv::import_csv_bytes`].
///
/// Type inference, BOM stripping, and engine-limit guards all follow
/// `ql-io-csv` semantics. Credentials are not used; local files have no
/// credential boundary.
pub struct CsvDataSource {
    id: String,
    path: PathBuf,
    options: CsvImportOptions,
}

impl CsvDataSource {
    /// Create a connector with the default CSV options (comma delimiter).
    pub fn new(id: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            id: id.into(),
            path: path.into(),
            options: CsvImportOptions::default(),
        }
    }

    /// Override CSV import options (e.g. `delimiter: b'\t'` for TSV).
    pub fn with_options(mut self, options: CsvImportOptions) -> Self {
        self.options = options;
        self
    }
}

impl DataSource for CsvDataSource {
    fn source_id(&self) -> &str {
        &self.id
    }

    fn load(&self, _credentials: &Credentials) -> Result<Workbook, ConnectorError> {
        let bytes = fs::read(&self.path).map_err(|e| ConnectorError::Io {
            source_id: self.id.clone(),
            source: e,
        })?;
        let result = import_csv_bytes(&bytes, self.options).map_err(|e| ConnectorError::Csv {
            source_id: self.id.clone(),
            source: e,
        })?;
        Ok(result.workbook)
    }
}

// ---------------------------------------------------------------------------
// Parquet connector — CONN-6-01 (v1 second connector)
// ---------------------------------------------------------------------------

/// Local-file Parquet connector. Reads via the `arrow`/`parquet` 58.x family
/// that is already in the workspace — no new heavy dependency.
///
/// Each Parquet row maps to one sheet row; columns map left-to-right. Null
/// cells become blanks (sparse, mirroring the CSV connector). The workbook has
/// one sheet named `"Sheet1"`. Arrow → engine type mapping:
///
/// | Arrow type | Engine `Value` |
/// |---|---|
/// | Boolean | `Value::Boolean` |
/// | Int{8,16,32,64} / UInt{8,16,32,64} | `Value::Number` (as f64) |
/// | Float32 / Float64 | `Value::Number` (non-finite → text) |
/// | Utf8 / LargeUtf8 | `Value::text` |
/// | anything else | **loud `ConnectorError::UnsupportedArrowType`** |
///
/// Any unsupported column type fails the whole load loudly (No-Fallbacks).
/// Credentials are not used; local files have no credential boundary.
pub struct ParquetDataSource {
    id: String,
    path: PathBuf,
}

impl ParquetDataSource {
    pub fn new(id: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            id: id.into(),
            path: path.into(),
        }
    }
}

impl DataSource for ParquetDataSource {
    fn source_id(&self) -> &str {
        &self.id
    }

    fn load(&self, _credentials: &Credentials) -> Result<Workbook, ConnectorError> {
        let file = fs::File::open(&self.path).map_err(|e| ConnectorError::Io {
            source_id: self.id.clone(),
            source: e,
        })?;

        let builder =
            ParquetRecordBatchReaderBuilder::try_new(file).map_err(|e| ConnectorError::Parquet {
                source_id: self.id.clone(),
                source: e,
            })?;

        // Pre-validate every column type from the Arrow schema BEFORE reading
        // any rows. This ensures that an unsupported column type (Date32,
        // Timestamp, Decimal, Binary, Dictionary, …) fails loud even when the
        // column is entirely null — null cells are skipped in the row loop, so
        // arrow_to_value is never called for them, and without this check an
        // all-null unsupported column is silently accepted (CONN-6-02 /
        // No-Fallbacks violation fixed here).
        for field in builder.schema().fields() {
            if !is_supported_arrow_type(field.data_type()) {
                return Err(ConnectorError::UnsupportedArrowType {
                    source_id: self.id.clone(),
                    arrow_type: format!("{:?}", field.data_type()),
                });
            }
        }

        let reader = builder.build().map_err(|e| ConnectorError::Parquet {
            source_id: self.id.clone(),
            source: e,
        })?;

        let mut wb = Workbook::new();
        let sheet: SheetId = wb.add_sheet("Sheet1");
        let mut global_row: u64 = 0;

        for batch_result in reader {
            let batch = batch_result.map_err(|e| ConnectorError::Parquet {
                source_id: self.id.clone(),
                source: e.into(),
            })?;

            let num_rows = batch.num_rows() as u64;
            let num_cols = batch.num_columns() as u64;

            // Guard engine limits before any put_at (which asserts on overflow).
            if global_row + num_rows > MAX_ROW as u64 + 1 {
                return Err(ConnectorError::ExceedsLimits {
                    source_id: self.id.clone(),
                    detail: format!(
                        "row count {} exceeds MAX_ROW={}",
                        global_row + num_rows,
                        MAX_ROW
                    ),
                });
            }
            if num_cols > MAX_COLUMN as u64 + 1 {
                return Err(ConnectorError::ExceedsLimits {
                    source_id: self.id.clone(),
                    detail: format!(
                        "column count {} exceeds MAX_COLUMN={}",
                        num_cols, MAX_COLUMN
                    ),
                });
            }

            let schema = batch.schema();
            for col_idx in 0..batch.num_columns() {
                let col = batch.column(col_idx);
                let dtype = schema.field(col_idx).data_type();
                for row_offset in 0..batch.num_rows() {
                    if col.is_null(row_offset) {
                        continue; // null → blank, keep workbook sparse
                    }
                    let v = arrow_to_value(col.as_ref(), dtype, row_offset, &self.id)?;
                    if !matches!(v, Value::Blank) {
                        wb.put_at(
                            sheet,
                            (global_row + row_offset as u64) as RowId,
                            col_idx as ColId,
                            v,
                        );
                    }
                }
            }
            global_row += num_rows;
        }

        Ok(wb)
    }
}

// ---------------------------------------------------------------------------
// Arrow type helpers
// ---------------------------------------------------------------------------

/// Return `true` for Arrow types that [`arrow_to_value`] can convert to an
/// engine [`Value`]. Used for up-front schema validation (catches unsupported
/// types even on all-null columns) and as the canonical supported-type list.
fn is_supported_arrow_type(dtype: &DataType) -> bool {
    matches!(
        dtype,
        DataType::Boolean
            | DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Float32
            | DataType::Float64
            | DataType::Utf8
            | DataType::LargeUtf8
    )
}

// ---------------------------------------------------------------------------
// Arrow → Value conversion
// ---------------------------------------------------------------------------

/// Convert one cell of an Arrow column array to an engine [`Value`].
///
/// Returns `Err(ConnectorError::UnsupportedArrowType)` for any Arrow type
/// outside the v1 supported set so the caller fails loud rather than storing
/// the schema type name as a cell value (No-Fallbacks, CONN-6-02).
///
/// The caller guarantees `!col.is_null(row)`.
fn arrow_to_value(
    col: &dyn Array,
    dtype: &DataType,
    row: usize,
    source_id: &str,
) -> Result<Value, ConnectorError> {
    use arrow_array::{
        BooleanArray, Float32Array, Float64Array, Int16Array, Int32Array, Int64Array, Int8Array,
        LargeStringArray, StringArray, UInt16Array, UInt32Array, UInt64Array, UInt8Array,
    };

    // Checked downcast: the dtype arm guarantees the concrete array type, but
    // we fail loud rather than panic if the arrow library ever breaks that
    // invariant (e.g. a future wrapper type that matches the same DataType).
    macro_rules! downcast {
        ($array_ty:ty) => {
            col.as_any()
                .downcast_ref::<$array_ty>()
                .ok_or_else(|| ConnectorError::Parquet {
                    source_id: source_id.to_string(),
                    source: parquet::errors::ParquetError::General(format!(
                        "unexpected downcast failure: expected {} for column type {:?}",
                        stringify!($array_ty),
                        dtype,
                    )),
                })?
        };
    }

    Ok(match dtype {
        DataType::Boolean => Value::Boolean(downcast!(BooleanArray).value(row)),
        DataType::Int8 => Value::Number(f64::from(downcast!(Int8Array).value(row))),
        DataType::Int16 => Value::Number(f64::from(downcast!(Int16Array).value(row))),
        DataType::Int32 => Value::Number(f64::from(downcast!(Int32Array).value(row))),
        DataType::Int64 => Value::Number(downcast!(Int64Array).value(row) as f64),
        DataType::UInt8 => Value::Number(f64::from(downcast!(UInt8Array).value(row))),
        DataType::UInt16 => Value::Number(f64::from(downcast!(UInt16Array).value(row))),
        DataType::UInt32 => Value::Number(f64::from(downcast!(UInt32Array).value(row))),
        DataType::UInt64 => Value::Number(downcast!(UInt64Array).value(row) as f64),
        DataType::Float32 => {
            let v = f64::from(downcast!(Float32Array).value(row));
            if v.is_finite() {
                Value::Number(v)
            } else {
                Value::text(format!("{v}"))
            }
        }
        DataType::Float64 => {
            let v = downcast!(Float64Array).value(row);
            if v.is_finite() {
                Value::Number(v)
            } else {
                Value::text(format!("{v}"))
            }
        }
        DataType::Utf8 => Value::text(downcast!(StringArray).value(row)),
        DataType::LargeUtf8 => Value::text(downcast!(LargeStringArray).value(row)),
        // Every other Arrow type (Date32, Timestamp, Decimal128, Binary,
        // Dictionary, List, Struct, …) is unsupported in v1. Fail loud so
        // the caller never silently stores a schema-type name as a cell value.
        other => {
            return Err(ConnectorError::UnsupportedArrowType {
                source_id: source_id.to_string(),
                arrow_type: format!("{other:?}"),
            });
        }
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// Build a tiny Parquet file with four typed columns for testing.
    fn make_parquet_file() -> NamedTempFile {
        use arrow_array::{BooleanArray, Float64Array, Int32Array, RecordBatch, StringArray};
        use arrow_schema::{Field, Schema};
        use parquet::arrow::ArrowWriter;
        use std::sync::Arc;

        let schema = Arc::new(Schema::new(vec![
            Field::new("name", DataType::Utf8, false),
            Field::new("score", DataType::Float64, false),
            Field::new("rank", DataType::Int32, false),
            Field::new("pass", DataType::Boolean, false),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(StringArray::from(vec!["Alice", "Bob", "Carol"])),
                Arc::new(Float64Array::from(vec![91.5_f64, 70.0, 85.0])),
                Arc::new(Int32Array::from(vec![1_i32, 3, 2])),
                Arc::new(BooleanArray::from(vec![true, false, true])),
            ],
        )
        .unwrap();

        let mut f = NamedTempFile::new().unwrap();
        {
            let mut writer = ArrowWriter::try_new(f.as_file_mut(), schema, None).unwrap();
            writer.write(&batch).unwrap();
            writer.close().unwrap();
        }
        f
    }

    // -----------------------------------------------------------------------
    // CSV connector (CONN-6-01)
    // -----------------------------------------------------------------------

    #[test]
    fn csv_load_basic_grid() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "name,score,passed\nAlice,91.5,TRUE\nBob,0,FALSE\n").unwrap();
        let src = CsvDataSource::new("test-csv", f.path());
        let wb = src.load(&Credentials::default()).unwrap();
        let s = wb.sheet(0).unwrap();
        assert_eq!(s.read(0, 0), Value::text("name"));
        assert_eq!(s.read(1, 1), Value::Number(91.5));
        assert_eq!(s.read(1, 2), Value::Boolean(true));
        assert_eq!(s.read(2, 2), Value::Boolean(false));
    }

    #[test]
    fn csv_source_id_is_stable() {
        let src = CsvDataSource::new("my-source", "/tmp/x.csv");
        assert_eq!(src.source_id(), "my-source");
    }

    #[test]
    fn csv_load_missing_file_fails_loud() {
        let src = CsvDataSource::new("missing", "/nonexistent/__no_such_file__.csv");
        let err = src.load(&Credentials::default()).unwrap_err();
        assert!(
            matches!(err, ConnectorError::Io { ref source_id, .. } if source_id == "missing"),
            "expected Io{{missing}}, got {err:?}"
        );
    }

    #[test]
    fn csv_load_non_utf8_fails_loud() {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(&[b'a', b',', 0xFF, b'\n']).unwrap();
        let src = CsvDataSource::new("bad-utf8", f.path());
        let err = src.load(&Credentials::default()).unwrap_err();
        assert!(
            matches!(err, ConnectorError::Csv { .. }),
            "expected ConnectorError::Csv, got {err:?}"
        );
    }

    #[test]
    fn csv_refresh_re_reads_updated_file() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "a,1\n").unwrap();
        let src = CsvDataSource::new("refresh-csv", f.path());

        let wb1 = src.refresh(&Credentials::default()).unwrap();

        // Overwrite the file with two rows.
        {
            let mut f2 = fs::File::create(f.path()).unwrap();
            write!(f2, "b,2\nc,3\n").unwrap();
        }

        let wb2 = src.refresh(&Credentials::default()).unwrap();
        assert_eq!(wb1.sheet(0).unwrap().read(0, 0), Value::text("a"));
        assert_eq!(wb2.sheet(0).unwrap().read(0, 0), Value::text("b"));
        assert_eq!(wb2.sheet(0).unwrap().read(1, 0), Value::text("c"));
    }

    #[test]
    fn csv_with_tab_delimiter() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "x\t42\n").unwrap();
        let opts = CsvImportOptions { delimiter: b'\t' };
        let src = CsvDataSource::new("tsv", f.path()).with_options(opts);
        let wb = src.load(&Credentials::default()).unwrap();
        assert_eq!(wb.sheet(0).unwrap().read(0, 1), Value::Number(42.0));
    }

    // -----------------------------------------------------------------------
    // Parquet connector
    // -----------------------------------------------------------------------

    #[test]
    fn parquet_load_basic_grid() {
        let f = make_parquet_file();
        let src = ParquetDataSource::new("test-parquet", f.path());
        let wb = src.load(&Credentials::default()).unwrap();
        let s = wb.sheet(0).unwrap();
        // Row 0: Alice, 91.5, 1, TRUE
        assert_eq!(s.read(0, 0), Value::text("Alice"));
        assert_eq!(s.read(0, 1), Value::Number(91.5));
        assert_eq!(s.read(0, 2), Value::Number(1.0));
        assert_eq!(s.read(0, 3), Value::Boolean(true));
        // Row 1: Bob, 70.0, 3, FALSE
        assert_eq!(s.read(1, 0), Value::text("Bob"));
        assert_eq!(s.read(1, 1), Value::Number(70.0));
        assert_eq!(s.read(1, 3), Value::Boolean(false));
        // Row 2: Carol, 85.0, 2, TRUE
        assert_eq!(s.read(2, 0), Value::text("Carol"));
        assert_eq!(s.read(2, 2), Value::Number(2.0));
        assert_eq!(s.read(2, 3), Value::Boolean(true));
    }

    #[test]
    fn parquet_source_id_is_stable() {
        let src = ParquetDataSource::new("my-parquet", "/tmp/x.parquet");
        assert_eq!(src.source_id(), "my-parquet");
    }

    #[test]
    fn parquet_load_missing_file_fails_loud() {
        let src = ParquetDataSource::new("missing-pq", "/nonexistent/__no_such__.parquet");
        let err = src.load(&Credentials::default()).unwrap_err();
        assert!(
            matches!(err, ConnectorError::Io { ref source_id, .. } if source_id == "missing-pq"),
            "expected Io{{missing-pq}}, got {err:?}"
        );
    }

    #[test]
    fn parquet_load_corrupt_file_fails_loud() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "this is not a parquet file — no magic bytes").unwrap();
        let src = ParquetDataSource::new("corrupt-pq", f.path());
        let err = src.load(&Credentials::default()).unwrap_err();
        assert!(
            matches!(err, ConnectorError::Parquet { .. }),
            "expected ConnectorError::Parquet, got {err:?}"
        );
    }

    #[test]
    fn parquet_refresh_re_reads_file() {
        let f = make_parquet_file();
        let src = ParquetDataSource::new("refresh-pq", f.path());
        let wb = src.refresh(&Credentials::default()).unwrap();
        assert_eq!(wb.sheet(0).unwrap().read(0, 0), Value::text("Alice"));
    }

    #[test]
    fn parquet_unsupported_column_type_fails_loud() {
        // Date32 is a common Parquet type that is NOT in the v1 supported set.
        // The load must fail loud with UnsupportedArrowType — never silently
        // store the schema type name as a cell value (No-Fallbacks, CONN-6-02).
        use arrow_array::{Date32Array, RecordBatch};
        use arrow_schema::{Field, Schema};
        use parquet::arrow::ArrowWriter;
        use std::sync::Arc;

        let schema = Arc::new(Schema::new(vec![
            Field::new("name", DataType::Utf8, false),
            Field::new("date_col", DataType::Date32, false),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(arrow_array::StringArray::from(vec!["Alice", "Bob"])),
                Arc::new(Date32Array::from(vec![19000_i32, 19001])),
            ],
        )
        .unwrap();

        let mut f = NamedTempFile::new().unwrap();
        {
            let mut writer = ArrowWriter::try_new(f.as_file_mut(), schema, None).unwrap();
            writer.write(&batch).unwrap();
            writer.close().unwrap();
        }

        let src = ParquetDataSource::new("unsupported-date32", f.path());
        let err = src.load(&Credentials::default()).unwrap_err();
        assert!(
            matches!(
                err,
                ConnectorError::UnsupportedArrowType { ref source_id, ref arrow_type }
                    if source_id == "unsupported-date32" && arrow_type.contains("Date32")
            ),
            "expected UnsupportedArrowType(Date32), got {err:?}"
        );
    }

    #[test]
    fn parquet_all_null_unsupported_column_fails_loud() {
        // An all-null Date32 column must STILL fail loud: null cells are skipped
        // before arrow_to_value is called, so without the schema pre-validation
        // the unsupported type goes undetected and the column is silently blank.
        // The schema pre-check catches this regardless of null status (CONN-6-02).
        use arrow_array::{Date32Array, RecordBatch};
        use arrow_schema::{Field, Schema};
        use parquet::arrow::ArrowWriter;
        use std::sync::Arc;

        let schema = Arc::new(Schema::new(vec![
            Field::new("name", DataType::Utf8, false),
            Field::new("date_col", DataType::Date32, true), // nullable
        ]));
        // All cells in date_col are null — arrow_to_value is never called for them.
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(arrow_array::StringArray::from(vec!["Alice", "Bob"])),
                Arc::new(Date32Array::from(vec![None::<i32>, None])),
            ],
        )
        .unwrap();

        let mut f = NamedTempFile::new().unwrap();
        {
            let mut writer = ArrowWriter::try_new(f.as_file_mut(), schema, None).unwrap();
            writer.write(&batch).unwrap();
            writer.close().unwrap();
        }

        let src = ParquetDataSource::new("all-null-date32", f.path());
        let err = src.load(&Credentials::default()).unwrap_err();
        assert!(
            matches!(
                err,
                ConnectorError::UnsupportedArrowType { ref source_id, ref arrow_type }
                    if source_id == "all-null-date32" && arrow_type.contains("Date32")
            ),
            "expected UnsupportedArrowType(Date32) for all-null column, got {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // DataSource is object-safe
    // -----------------------------------------------------------------------

    #[test]
    fn data_source_is_dyn_safe_csv() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "x,1\n").unwrap();
        let src: Box<dyn DataSource> = Box::new(CsvDataSource::new("dyn-csv", f.path()));
        assert_eq!(src.source_id(), "dyn-csv");
        let wb = src.load(&Credentials::default()).unwrap();
        assert_eq!(wb.sheet(0).unwrap().read(0, 0), Value::text("x"));
    }

    #[test]
    fn data_source_is_dyn_safe_parquet() {
        let f = make_parquet_file();
        let src: Box<dyn DataSource> = Box::new(ParquetDataSource::new("dyn-pq", f.path()));
        assert_eq!(src.source_id(), "dyn-pq");
        let wb = src.load(&Credentials::default()).unwrap();
        assert_eq!(wb.sheet(0).unwrap().read(0, 0), Value::text("Alice"));
    }

    // -----------------------------------------------------------------------
    // Error message visibility (CONN-6-02)
    // -----------------------------------------------------------------------

    #[test]
    fn credentials_debug_redacts_token() {
        // 6.7 C-M1: the secret must never appear in Debug output.
        let c = Credentials {
            token: Some("super-secret-api-key".to_string()),
        };
        let dbg = format!("{c:?}");
        assert!(!dbg.contains("super-secret-api-key"), "secret leaked: {dbg}");
        assert!(dbg.contains("redacted"), "expected redaction marker: {dbg}");
        // Absent token is shown as None (no value to leak).
        assert!(format!("{:?}", Credentials::default()).contains("None"));
    }

    #[test]
    fn error_messages_include_source_id() {
        let src = CsvDataSource::new("vis-test", "/no/such/file.csv");
        let err = src.load(&Credentials::default()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("vis-test"), "source_id absent in '{msg}'");
    }
}
