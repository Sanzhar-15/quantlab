//! Populate a `Workbook` from the calamine grid output.
//!
//! **W5-D-14a:** minimum viable conversion — sheets + cells + formula
//! text. No name resolution, no table reconstruction, no style
//! mapping (those land in subsequent W5-D-14 commits).

use crate::error::XlsxError;
use crate::read::calamine_grid::CalamineGrid;
use crate::report::{FormulaImportFailure, XlsxImportReport};
use ql_storage::Workbook;

/// Build a `Workbook` from the calamine grid reader.
///
/// **W5-D-14a:** does NOT perform formula recompute. The caller (the
/// public `import_xlsx_*` entry points) drives recompute as a
/// separate phase per Codex's architecture review (raw-load first,
/// recompute as a reportable phase).
///
/// Returns:
/// - The populated `Workbook` (sheets created in calamine order;
///   cells + formula text written via the storage-direct
///   `put_at` / `put_formula`).
/// - The number of cells loaded (for the export report counter).
/// - The number of formula texts loaded.
pub(crate) fn build_workbook_from_grid(
    grid: &mut CalamineGrid,
    report: &mut XlsxImportReport,
) -> Result<(Workbook, u64, u64), XlsxError> {
    let mut wb = Workbook::new();
    let mut cells_loaded: u64 = 0;
    let mut formulas_loaded: u64 = 0;

    for (sheet_idx, sheet_name) in grid.sheet_names().iter().enumerate() {
        // Quantbook's add_sheet validates the name (rejects empty /
        // duplicate / reserved chars). If calamine returns a name the
        // engine refuses (e.g. a sheet named `[`), surface that as a
        // structured xlsx error rather than panicking.
        let sheet_id = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wb.add_sheet(sheet_name)
        })) {
            Ok(id) => id,
            Err(_) => {
                return Err(XlsxError::MalformedOoxml {
                    part: format!("workbook sheet[{sheet_idx}]"),
                    message: format!(
                        "sheet name {sheet_name:?} rejected by Workbook::add_sheet (empty, duplicate, or contains a reserved character)"
                    ),
                });
            }
        };

        // Iterate the sheet's populated cells. Calamine collapses
        // empty cells, so the iteration only yields cells with
        // values or formulas.
        let cells = grid.iter_sheet(sheet_name)?;
        for cell in cells {
            // Bounds check against engine MAX_ROW/MAX_COLUMN. The
            // engine's put_at/put_formula panic on out-of-bounds, but
            // here at the xlsx trust boundary we want a structured
            // error.
            if cell.row > ql_types::MAX_ROW {
                report.warnings.push(crate::report::XlsxWarning {
                    location: format!("{sheet_name}!{}", cell.row + 1),
                    message: format!(
                        "row {} exceeds Quantbook MAX_ROW ({}); cell skipped",
                        cell.row + 1,
                        ql_types::MAX_ROW + 1
                    ),
                });
                continue;
            }
            if cell.col > ql_types::MAX_COLUMN {
                report.warnings.push(crate::report::XlsxWarning {
                    location: format!("{sheet_name}!col{}", cell.col + 1),
                    message: format!(
                        "column {} exceeds Quantbook MAX_COLUMN ({}); cell skipped",
                        cell.col + 1,
                        ql_types::MAX_COLUMN + 1
                    ),
                });
                continue;
            }

            // Write the cached cell value (recompute may overwrite
            // it for formula cells).
            wb.put_at(sheet_id, cell.row, cell.col, cell.value.clone());
            cells_loaded += 1;

            // Write the formula text if the cell has one. We use
            // storage-direct `put_formula` (not the runtime path) per
            // Codex's "raw-load first, recompute as separate phase"
            // architecture.
            if let Some(formula) = cell.formula {
                wb.put_formula(sheet_id, cell.row, cell.col, formula);
                formulas_loaded += 1;
            }
        }
    }

    Ok((wb, cells_loaded, formulas_loaded))
}

/// Run the recompute pass on every formula cell. Failures are
/// collected into `report.formula_failures` but DO NOT abort the
/// import — the imported cached value is preserved for any formula
/// the engine couldn't evaluate. Per `RecomputeMode::BestEffort`
/// (the default).
///
/// **W5-D-14a:** this is the bridge between the xlsx import path and
/// the engine's `WorkbookRuntime::recompute_all`. The recompute
/// runner mode (`Strict` / `BestEffort` / `Skip`) is dispatched at
/// the public-API layer.
pub(crate) fn recompute_loaded_workbook(
    wb: Workbook,
    registry: &ql_functions::FunctionRegistry,
    report: &mut XlsxImportReport,
) -> Result<Workbook, XlsxError> {
    // The runtime borrows the workbook mutably and the registry by
    // reference. We construct it, run recompute_all, then deconstruct
    // (the runtime is per-recompute; the workbook lives on).
    let mut wb = wb;
    let mut rt = ql_exec::WorkbookRuntime::new(&mut wb, registry);

    // recompute_all evaluates every formula cell in topological
    // order. Per its docs, it reports per-cell failures and produces
    // a summary count; it does not abort on the first failure.
    let result = rt.recompute_all();

    // Translate structural failures (lex/parse/bind errors) into
    // FormulaImportFailure entries. The runtime carries the cell
    // address + formula text + error directly on each `RecomputeFailure`.
    //
    // Note: evaluation errors that produce a `Value::Error(_)` cell
    // (e.g. `#DIV/0!`, `#N/A`) are NOT failures — they're normal cell
    // values. We only report structural failures here.
    for failure in result.failures.iter() {
        report.formula_failures.push(FormulaImportFailure {
            sheet: failure.sheet,
            row: failure.row,
            col: failure.col,
            formula: failure.formula_text.to_string(),
            reason: format!("{:?}", failure.error),
        });
    }

    Ok(wb)
}
