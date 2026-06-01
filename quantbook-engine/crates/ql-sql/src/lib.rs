//! `ql-sql` -- Phase 6.5-1: off-hot-path SQL over workbook tables/sheets via DataFusion.
//!
//! PURE Arrow-in -> SQL -> Arrow-out. The caller (the `ql-exec` `WorkbookSession`
//! `materialize_query` path) builds one RecordBatch per registered table/sheet, runs
//! a SQL string here, and converts the result RecordBatch back into cell values. This
//! crate has NO engine deps (no `ql-session`/`ql-storage`/`ql-exec`) -- it is reusable
//! and independently testable. T1-D03 keeps the Arrow scalar kernels on the recompute
//! HOT path; SQL is off-hot-path, so DataFusion is allowed here (and is the planned
//! path the `ql-sql` stub doc named).

use std::sync::Arc;

use arrow_array::RecordBatch;
use arrow_schema::SchemaRef;
use datafusion::prelude::{SQLOptions, SessionConfig, SessionContext};
use thiserror::Error;

/// An error from the SQL engine -- always loud (No-Fallbacks). A bad query, unknown
/// table/column, or type error surfaces here rather than yielding an empty/default
/// result.
#[derive(Debug, Error)]
pub enum SqlError {
    /// DataFusion parse / planning / execution error (message preserved verbatim).
    #[error("sql: {0}")]
    DataFusion(String),
    /// The async runtime backing DataFusion's `collect` could not be built / the SQL
    /// worker thread could not be spawned.
    #[error("sql: {0}")]
    Runtime(String),
    /// The result exceeded the caller's row cap (a runaway cross-join / series). The
    /// execution is bounded at `max + 1` rows so this fails loud WITHOUT collecting the
    /// whole result into memory.
    #[error("sql: result has more than {max} row(s)")]
    ResultTooLarge {
        /// The row cap the caller requested.
        max: usize,
    },
    /// The SQL worker thread panicked (a DataFusion-internal panic). Surfaced as a loud
    /// error rather than unwinding across the caller's FFI boundary / aborting the host.
    #[error("sql: query execution panicked")]
    Panicked,
}

/// Run `sql` over the given named in-memory tables, returning the result as a single
/// RecordBatch (partitions concatenated; a zero-row result keeps the result schema).
/// Execution stops after `max_rows + 1` rows so a runaway query cannot OOM; a result
/// larger than `max_rows` is a loud [`SqlError::ResultTooLarge`].
///
/// Each `(name, batch)` is registered as a queryable table named `name`. Names with
/// spaces/punctuation or that are SQL keywords must be quoted in the SQL (standard SQL
/// identifier rules); with identifier normalization off, a quoted name must match the
/// registered name case-exactly.
///
/// **Runtime isolation:** the synchronous DataFusion execution runs on a DEDICATED OS
/// thread that owns a fresh current-thread tokio runtime. This (a) lets a synchronous
/// caller that is ITSELF running inside a tokio runtime (e.g. the ql-service async HTTP
/// handler) call this without the "cannot start a runtime from within a runtime" panic,
/// and (b) isolates any DataFusion-internal panic -- it is caught at the thread join and
/// returned as [`SqlError::Panicked`] rather than unwinding across the caller's FFI
/// boundary. **Security:** DDL/DML/statements are forbidden, so a query cannot `COPY`/
/// `CREATE EXTERNAL TABLE`/`SET` to reach the filesystem/network -- read-only `SELECT`
/// over the registered tables only.
pub fn run_sql(
    tables: Vec<(String, RecordBatch)>,
    sql: &str,
    max_rows: usize,
) -> Result<RecordBatch, SqlError> {
    let sql = sql.to_string();
    let handle = std::thread::Builder::new()
        .name("ql-sql".to_string())
        .spawn(move || run_sql_blocking(tables, &sql, max_rows))
        .map_err(|e| SqlError::Runtime(e.to_string()))?;
    match handle.join() {
        Ok(result) => result,
        Err(_) => Err(SqlError::Panicked),
    }
}

/// Build the current-thread runtime + drive the async query to completion. Runs on the
/// dedicated worker thread spawned by [`run_sql`] (no ambient runtime here, so
/// `block_on` is safe).
fn run_sql_blocking(
    tables: Vec<(String, RecordBatch)>,
    sql: &str,
    max_rows: usize,
) -> Result<RecordBatch, SqlError> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| SqlError::Runtime(e.to_string()))?;
    rt.block_on(run_sql_async(tables, sql, max_rows))
}

async fn run_sql_async(
    tables: Vec<(String, RecordBatch)>,
    sql: &str,
    max_rows: usize,
) -> Result<RecordBatch, SqlError> {
    let mut config = SessionConfig::new().with_target_partitions(1);
    // Preserve identifier case: a sheet named `Sheet1` / column `A` must be queryable
    // as `FROM Sheet1` / `SELECT A` without quoting (the spreadsheet mental model).
    // With DataFusion's default normalization, unquoted identifiers are lowercased and
    // would not match the case-exact registered table/column names.
    config.options_mut().sql_parser.enable_ident_normalization = false;
    let ctx = SessionContext::new_with_config(config);
    for (name, batch) in tables {
        ctx.register_batch(&name, batch)
            .map_err(|e| SqlError::DataFusion(e.to_string()))?;
    }
    // SECURITY: forbid DDL/DML/statements. Without this, DataFusion's default options
    // accept `COPY (SELECT ...) TO '/path'` / `CREATE EXTERNAL TABLE ... LOCATION ...` /
    // `SET ...`, which reach local-filesystem-backed providers -- an arbitrary file
    // write / external read / config change from a single query string. Only read-only
    // `SELECT` over the registered in-memory tables is allowed.
    let opts = SQLOptions::new()
        .with_allow_ddl(false)
        .with_allow_dml(false)
        .with_allow_statements(false);
    let df = ctx
        .sql_with_options(sql, opts)
        .await
        .map_err(|e| SqlError::DataFusion(e.to_string()))?;
    // Bound execution: stop after `max_rows + 1` rows so a runaway cross-join / series
    // cannot collect an unbounded result into memory. `limit` pushes a fetch into the
    // plan, so collection itself is bounded.
    let df = df
        .limit(0, Some(max_rows.saturating_add(1)))
        .map_err(|e| SqlError::DataFusion(e.to_string()))?;
    // Capture the Arrow result schema BEFORE `collect` consumes the DataFrame, so a
    // zero-row result still carries its columns.
    let schema: SchemaRef = Arc::new(df.schema().as_arrow().clone());
    let batches = df
        .collect()
        .await
        .map_err(|e| SqlError::DataFusion(e.to_string()))?;
    let result = arrow_select::concat::concat_batches(&schema, &batches)
        .map_err(|e| SqlError::DataFusion(e.to_string()))?;
    if result.num_rows() > max_rows {
        return Err(SqlError::ResultTooLarge { max: max_rows });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::{Array, Float64Array, Int64Array, StringArray};
    use arrow_schema::{DataType, Field, Schema};

    /// A 3-row `sales` table: qty (Float64) + name (Utf8).
    fn sample() -> (String, RecordBatch) {
        let schema = Arc::new(Schema::new(vec![
            Field::new("qty", DataType::Float64, true),
            Field::new("name", DataType::Utf8, true),
        ]));
        let qty = Arc::new(Float64Array::from(vec![Some(10.0), Some(20.0), Some(30.0)]));
        let name = Arc::new(StringArray::from(vec![Some("a"), Some("b"), Some("a")]));
        (
            "sales".to_string(),
            RecordBatch::try_new(schema, vec![qty, name]).unwrap(),
        )
    }

    const CAP: usize = 10_000;

    #[test]
    fn select_filter_orders_rows() {
        let r = run_sql(
            vec![sample()],
            "SELECT qty FROM sales WHERE qty > 15 ORDER BY qty",
            CAP,
        )
        .unwrap();
        assert_eq!(r.num_rows(), 2);
        let col = r.column(0).as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(col.value(0), 20.0);
        assert_eq!(col.value(1), 30.0);
    }

    #[test]
    fn aggregate_sum_group_by() {
        let r = run_sql(
            vec![sample()],
            "SELECT name, SUM(qty) AS total FROM sales GROUP BY name ORDER BY name",
            CAP,
        )
        .unwrap();
        assert_eq!(r.num_rows(), 2);
        let names = r.column(0).as_any().downcast_ref::<StringArray>().unwrap();
        let totals = r.column(1).as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!((names.value(0), totals.value(0)), ("a", 40.0));
        assert_eq!((names.value(1), totals.value(1)), ("b", 20.0));
    }

    #[test]
    fn count_star_is_int64() {
        let r = run_sql(vec![sample()], "SELECT COUNT(*) AS n FROM sales", CAP).unwrap();
        assert_eq!(r.num_rows(), 1);
        let n = r.column(0).as_any().downcast_ref::<Int64Array>().unwrap();
        assert_eq!(n.value(0), 3);
    }

    #[test]
    fn unknown_table_is_loud() {
        assert!(matches!(
            run_sql(vec![sample()], "SELECT * FROM nope", CAP).unwrap_err(),
            SqlError::DataFusion(_)
        ));
    }

    #[test]
    fn syntax_error_is_loud() {
        assert!(matches!(
            run_sql(vec![sample()], "SELEKT *", CAP).unwrap_err(),
            SqlError::DataFusion(_)
        ));
    }

    #[test]
    fn zero_row_result_keeps_schema() {
        let r = run_sql(
            vec![sample()],
            "SELECT qty FROM sales WHERE qty > 1000",
            CAP,
        )
        .unwrap();
        assert_eq!(r.num_rows(), 0);
        assert_eq!(r.num_columns(), 1);
    }

    // --- Security: DDL/DML/statements forbidden (no file write / external read / SET) ---

    #[test]
    fn copy_to_file_is_rejected() {
        // Without the SQLOptions restriction this would WRITE a file to disk.
        let err = run_sql(
            vec![sample()],
            "COPY (SELECT qty FROM sales) TO '/tmp/ql_sql_exfil.csv' STORED AS CSV",
            CAP,
        )
        .unwrap_err();
        assert!(matches!(err, SqlError::DataFusion(_)), "got {err:?}");
    }

    #[test]
    fn create_external_table_is_rejected() {
        let err = run_sql(
            vec![sample()],
            "CREATE EXTERNAL TABLE leak STORED AS CSV LOCATION '/etc/passwd'",
            CAP,
        )
        .unwrap_err();
        assert!(matches!(err, SqlError::DataFusion(_)), "got {err:?}");
    }

    #[test]
    fn set_statement_is_rejected() {
        let err = run_sql(
            vec![sample()],
            "SET datafusion.execution.batch_size = 1",
            CAP,
        )
        .unwrap_err();
        assert!(matches!(err, SqlError::DataFusion(_)), "got {err:?}");
    }

    // --- Resource bound: result row cap ---

    #[test]
    fn result_over_cap_is_loud() {
        // sample() has 3 rows; cap at 1 -> execution stops at 2 rows -> ResultTooLarge
        // (the whole result is NOT collected).
        let err = run_sql(vec![sample()], "SELECT qty FROM sales", 1).unwrap_err();
        assert!(
            matches!(err, SqlError::ResultTooLarge { max: 1 }),
            "got {err:?}"
        );
    }

    #[test]
    fn result_exactly_at_cap_ok() {
        let r = run_sql(vec![sample()], "SELECT qty FROM sales", 3).unwrap();
        assert_eq!(r.num_rows(), 3);
    }

    // --- Runtime isolation: callable from WITHIN an existing tokio runtime ---

    #[tokio::test]
    async fn runs_from_within_a_tokio_runtime() {
        // The ql-service async HTTP handler calls the (sync) engine session method, which
        // calls run_sql. The dedicated worker thread means the inner `block_on` does NOT
        // hit "cannot start a runtime from within a runtime".
        let r = run_sql(vec![sample()], "SELECT COUNT(*) AS n FROM sales", CAP);
        assert!(
            r.is_ok(),
            "run_sql must not panic inside a tokio runtime: {r:?}"
        );
    }
}
