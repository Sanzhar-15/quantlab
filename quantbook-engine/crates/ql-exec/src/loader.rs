//! `load_workbook_and_recompute` — Phase 2A.4 convenience.
//!
//! `ql_io::load_workbook` rehydrates a workbook from a `.qbook/` directory but
//! leaves formula values as whatever was saved (could be stale if the workbook
//! was saved before its last edit cycle). Callers that want the formula cells
//! to reflect the current state of their dependencies have to:
//!
//! 1. `let mut wb = ql_io::load_workbook(path)?;`
//! 2. `let mut rt = WorkbookRuntime::new(&mut wb, &registry);`
//! 3. `rt.recompute_all()?;`
//!
//! Phase 2A.4 collapses that to one call. The IDE's "Open file…" path uses it.
//!
//! Returns the recomputed `Workbook` on success. The error type covers both
//! load failures (`QbookError`) and recompute failures (`RuntimeError`).

use std::path::Path;

use ql_functions::FunctionRegistry;
use ql_io::QbookError;
use ql_storage::Workbook;

use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

/// Combined error for the load + recompute pipeline.
#[derive(Debug, thiserror::Error)]
pub enum LoadAndRecomputeError {
    #[error("qbook load error: {0}")]
    Load(#[from] QbookError),

    #[error("recompute error: {0}")]
    Recompute(#[from] RuntimeError),
}

/// Load a `.qbook/` directory and immediately recompute every formula cell so
/// the returned workbook's values reflect the current state of dependencies.
///
/// The recompute does the full lex → parse → bind → eval pipeline for each
/// formula. Iteration order is HashMap-arbitrary (same caveat as
/// `WorkbookRuntime::recompute_all`); intra-workbook formula→formula
/// dependencies may evaluate in an order that produces stale intermediate
/// values. Phase 4 calcgraph integration fixes that.
///
/// Errors from either stage surface as `LoadAndRecomputeError` — load errors
/// short-circuit before any recompute work; recompute errors leave the
/// workbook in a partial state (matching `WorkbookRuntime::recompute_all`).
pub fn load_workbook_and_recompute(
    path: &Path,
    registry: &FunctionRegistry,
) -> Result<Workbook, LoadAndRecomputeError> {
    let mut workbook = ql_io::load_workbook(path)?;
    {
        let mut runtime = WorkbookRuntime::new(&mut workbook, registry);
        runtime.recompute_all()?;
    }
    Ok(workbook)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_functions::default_registry;
    use ql_io::save_workbook;
    use ql_types::{Address, Value};
    use tempfile::TempDir;

    fn temp_path(name: &str) -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(name);
        (dir, path)
    }

    #[test]
    fn load_and_recompute_refreshes_formula_values() {
        // Save a workbook with a formula; then tamper with the on-disk cached
        // value (simulated by computing a formula against one A1 value, then
        // changing A1 before the load). load_workbook_and_recompute should
        // re-evaluate so the formula reflects the new A1.
        let (_dir, path) = temp_path("refresh.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 1, 0, "A1 * 2").unwrap(); // = 20
        }
        // Now mutate A1 *before* saving (so the saved value of B1=20 is stale
        // relative to A1=100).
        wb.put_at(s, 0, 0, Value::Number(100.0));
        save_workbook(&wb, "refresh", &path).unwrap();

        // Load via the convenience — it should recompute B1 against A1=100.
        let loaded = load_workbook_and_recompute(&path, &reg).unwrap();
        assert_eq!(loaded.read(Address::new(s, 0, 0)), Value::Number(100.0));
        assert_eq!(loaded.read(Address::new(s, 1, 0)), Value::Number(200.0));
        // Formula text preserved.
        assert_eq!(
            loaded.formula_at(s, 1, 0).map(|s| s.as_ref()),
            Some("A1 * 2")
        );
    }

    #[test]
    fn load_and_recompute_on_workbook_without_formulas_is_clean() {
        let (_dir, path) = temp_path("noformula.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(42.0));
        wb.put_at(s, 0, 1, Value::text("hello"));
        save_workbook(&wb, "noformula", &path).unwrap();

        let reg = default_registry();
        let loaded = load_workbook_and_recompute(&path, &reg).unwrap();
        assert_eq!(loaded.read(Address::new(s, 0, 0)), Value::Number(42.0));
        assert_eq!(loaded.read(Address::new(s, 0, 1)), Value::text("hello"));
    }

    #[test]
    fn load_failure_surfaces_as_load_error() {
        let reg = default_registry();
        let missing = std::path::Path::new("/tmp/does-not-exist-2026.qbook");
        let result = load_workbook_and_recompute(missing, &reg);
        assert!(
            matches!(result, Err(LoadAndRecomputeError::Load(_))),
            "expected Load error for missing path, got {result:?}"
        );
    }

    #[test]
    fn empty_workbook_loads_and_recomputes_trivially() {
        let (_dir, path) = temp_path("empty.qbook");
        let wb = Workbook::new();
        save_workbook(&wb, "empty", &path).unwrap();

        let reg = default_registry();
        let loaded = load_workbook_and_recompute(&path, &reg).unwrap();
        assert_eq!(loaded.sheet_count(), 0);
    }

    #[test]
    fn multiple_formulas_all_recomputed() {
        let (_dir, path) = temp_path("multi.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(7.0));
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 1, 0, "A1 + 1").unwrap(); // = 8
            rt.set_formula(s, 2, 0, "A1 * 10").unwrap(); // = 70
            rt.set_formula(s, 3, 0, "A1 - 100").unwrap(); // = -93
        }
        // Tamper with A1 before save.
        wb.put_at(s, 0, 0, Value::Number(5.0));
        save_workbook(&wb, "multi", &path).unwrap();

        let loaded = load_workbook_and_recompute(&path, &reg).unwrap();
        // Recomputed against A1=5:
        assert_eq!(loaded.read(Address::new(s, 1, 0)), Value::Number(6.0));
        assert_eq!(loaded.read(Address::new(s, 2, 0)), Value::Number(50.0));
        assert_eq!(loaded.read(Address::new(s, 3, 0)), Value::Number(-95.0));
    }

    #[test]
    fn named_range_formula_round_trips_through_load_and_recompute() {
        use ql_storage::NamedTarget;
        let (_dir, path) = temp_path("named.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)));
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 0, 0, "1000 * TaxRate").unwrap();
        }
        // NOTE: named-ranges aren't persisted to .qbook yet (deferred to Phase
        // 2B+ — see ql-io::qbook_format). So after load, the NameTable is empty
        // and the formula =1000*TaxRate would fail to bind. This test pins the
        // current limitation: we expect a Recompute error from the loader.
        save_workbook(&wb, "named", &path).unwrap();
        let result = load_workbook_and_recompute(&path, &reg);
        assert!(
            matches!(result, Err(LoadAndRecomputeError::Recompute(_))),
            "expected Recompute(UnresolvedName) since .qbook NameTable persistence is Phase 2B+, got {result:?}"
        );
    }
}
