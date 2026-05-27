//! `EngineXlsxRecomputer` — the engine-layer implementation of
//! [`ql_io_xlsx::XlsxRecomputer`] (Phase 6.1B inc.2c-10).
//!
//! `ql-io-xlsx` is pure I/O and cannot depend on `ql-exec` (that would form an
//! `ql-exec → ql-io-xlsx → ql-exec` cycle, since `ql-exec` owns
//! `WorkbookSession::import` which calls the importer). It therefore defines the
//! `XlsxRecomputer` trait and the importer accepts an injected recomputer; this
//! is the engine's implementation, wrapping [`WorkbookRuntime::recompute_all`].
//!
//! This is the inverse of the former `ql_io_xlsx::read::convert::
//! recompute_loaded_workbook`, moved here verbatim when the dependency was
//! inverted. It is **public** so `ql-io-xlsx`'s own tests can recompute through
//! the real engine via their `ql-exec` dev-dependency
//! (`import_xlsx_bytes(.., Some(&ql_exec::EngineXlsxRecomputer))`).

use ql_functions::FunctionRegistry;
use ql_io_xlsx::{FormulaImportFailure, XlsxImportReport, XlsxRecomputer};
use ql_storage::Workbook;

use crate::WorkbookRuntime;

/// Engine-backed formula-recompute provider for xlsx import. Zero-sized.
#[derive(Debug, Default, Clone, Copy)]
pub struct EngineXlsxRecomputer;

impl XlsxRecomputer for EngineXlsxRecomputer {
    fn recompute_into(
        &self,
        mut wb: Workbook,
        registry: &FunctionRegistry,
        report: &mut XlsxImportReport,
    ) -> Workbook {
        // recompute_all evaluates every formula cell in topological order; per
        // its contract it reports per-cell failures and does NOT abort on the
        // first failure (BestEffort — the public-API Strict abort is decided by
        // the importer after this returns, by inspecting `formula_failures`).
        let result = {
            let mut rt = WorkbookRuntime::new(&mut wb, registry);
            rt.recompute_all()
        };
        // Translate STRUCTURAL failures (lex/parse/bind) into the import report.
        // Evaluation errors that produce a `Value::Error` cell (e.g. `#DIV/0!`,
        // `#N/A`) are normal cell values, NOT failures — `recompute_all` does not
        // list them here.
        for failure in result.failures.iter() {
            report.formula_failures.push(FormulaImportFailure {
                sheet: failure.sheet,
                row: failure.row,
                col: failure.col,
                formula: failure.formula_text.to_string(),
                reason: format!("{:?}", failure.error),
            });
        }
        wb
    }
}
