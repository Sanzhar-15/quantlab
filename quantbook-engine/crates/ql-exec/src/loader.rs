//! `load_workbook_and_recompute` — Phase 2A.4 convenience.
//!
//! `ql_io::load_workbook` rehydrates a workbook from a `.qbook/` directory but
//! leaves formula values as whatever was saved (could be stale if the workbook
//! was saved before its last edit cycle). Callers that want the formula cells
//! to reflect the current state of their dependencies have to:
//!
//! 1. `let mut wb = ql_io::load_workbook(path)?;`
//! 2. `let mut rt = WorkbookRuntime::new(&mut wb, &registry);`
//! 3. `let _ = rt.recompute_all();`
//!
//! Phase 2A.4 collapses that to one call. The IDE's "Open file…" path uses
//! it.
//!
//! ## Phase 2B.2 (2026-05-12)
//!
//! Signature simplified from `Result<Workbook, LoadAndRecomputeError>` to
//! `Result<(Workbook, RecomputeResult), QbookError>`. The prior shape had
//! two failure modes (load error vs recompute error) and stuffed the
//! partially-recomputed workbook into the error variant per Phase 2A.6
//! audit M5. With the new [`RecomputeResult`] aggregating per-cell
//! failures instead of short-circuiting, recompute is no longer fallible
//! at the API level — it always returns a result. Load is the only
//! remaining short-circuit, so the outer `Result` only handles that.
//! Callers inspect `RecomputeResult::is_complete()` / `.failures` to see
//! whether the workbook came back fully consistent. Tracked as GAP-R-02
//! in `docs/known-gaps.md`.

use std::path::Path;

use ql_functions::FunctionRegistry;
use ql_io::QbookError;
use ql_storage::Workbook;

use crate::workbook_runtime::{RecomputeResult, WorkbookRuntime};

/// Load a `.qbook/` directory and immediately recompute every formula cell.
///
/// Returns `(Workbook, RecomputeResult)` on a successful load. The workbook
/// has every formula re-evaluated where possible; cells whose formulas failed
/// structurally keep their pre-load values, and the failure detail is in
/// `RecomputeResult::failures`. Callers wanting "all-or-nothing" semantics
/// can check `recompute.is_complete()` and discard the workbook on
/// partial-state.
///
/// The recompute does the full lex → parse → bind → eval pipeline for each
/// formula. Iteration order is HashMap-arbitrary (same caveat as
/// `WorkbookRuntime::recompute_all`); intra-workbook formula→formula
/// dependencies may evaluate in an order that produces stale intermediate
/// values. Engine Phase 3 calcgraph integration fixes that (see
/// `docs/MASTER-PLAN.md` Phase 3.4; tracked as GAP-R-01).
///
/// Only `QbookError` short-circuits (file missing, schema mismatch, malformed
/// cell, etc.). Recompute failures are aggregated into `RecomputeResult`
/// without losing the workbook.
///
/// **6.4-4 megaudit note (UDF data-loss):** this builds a `WorkbookRuntime` with
/// NO UDF worker and calls the HONEST `recompute_all` — so a `.qbook` carrying
/// SAVED Python-UDF values, loaded through THIS function, would recompute those
/// cells to `#CALC!` (the D2 data-loss the 6.4-3c megaudit closed). It is safe
/// today because the product loads via `WorkbookSession::open`, which uses
/// `recompute_all_preserving_saved_udf` to keep saved UDF values when no worker
/// is present. Do NOT wire this standalone loader as the `.qbook` open path for a
/// workbook that may contain UDF values without first injecting the worker (or
/// switching to the preserving variant).
pub fn load_workbook_and_recompute(
    path: &Path,
    registry: &FunctionRegistry,
) -> Result<(Workbook, RecomputeResult), QbookError> {
    let mut workbook = ql_io::load_workbook(path)?;
    let recompute = {
        let mut runtime = WorkbookRuntime::new(&mut workbook, registry);
        runtime.recompute_all()
    };
    Ok((workbook, recompute))
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
        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
        assert!(result.is_complete());
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
        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
        assert_eq!(result.attempted, 0);
        assert!(result.is_complete());
        assert_eq!(loaded.read(Address::new(s, 0, 0)), Value::Number(42.0));
        assert_eq!(loaded.read(Address::new(s, 0, 1)), Value::text("hello"));
    }

    #[test]
    fn load_failure_surfaces_as_qbook_error() {
        let reg = default_registry();
        let missing = std::path::Path::new("/tmp/does-not-exist-2026.qbook");
        let result = load_workbook_and_recompute(missing, &reg);
        assert!(
            result.is_err(),
            "expected QbookError for missing path, got {result:?}"
        );
    }

    #[test]
    fn empty_workbook_loads_and_recomputes_trivially() {
        let (_dir, path) = temp_path("empty.qbook");
        let wb = Workbook::new();
        save_workbook(&wb, "empty", &path).unwrap();

        let reg = default_registry();
        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
        assert_eq!(loaded.sheet_count(), 0);
        assert_eq!(result.attempted, 0);
        assert!(result.is_complete());
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

        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
        assert_eq!(result.succeeded, 3);
        assert!(result.is_complete());
        // Recomputed against A1=5:
        assert_eq!(loaded.read(Address::new(s, 1, 0)), Value::Number(6.0));
        assert_eq!(loaded.read(Address::new(s, 2, 0)), Value::Number(50.0));
        assert_eq!(loaded.read(Address::new(s, 3, 0)), Value::Number(-95.0));
    }

    /// Phase 2A.8 audit M12 closure (was: pinned the persistence gap): named
    /// ranges now round-trip through save/load via the schema-v2 `names`
    /// section. A formula referencing a registered name resolves cleanly on
    /// reload.
    #[test]
    fn named_range_formula_round_trips_through_load_and_recompute() {
        use ql_storage::NamedTarget;
        let (_dir, path) = temp_path("named.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 0, 0, "1000 * TaxRate").unwrap();
        }
        save_workbook(&wb, "named", &path).unwrap();

        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
        assert!(result.is_complete());
        // Name survived the round-trip + the formula recomputed against it.
        assert_eq!(loaded.read(Address::new(s, 0, 0)), Value::Number(210.0));
        // Formula text canonicalized through set_formula's
        // lex→parse→print_with(A1, EnUs) pipeline (W5-147 / Phase
        // 4.9.K). NameRef identifiers are uppercased by the parser
        // per Excel canon, so `TaxRate` round-trips as `TAXRATE`.
        assert_eq!(
            loaded.formula_at(s, 0, 0).map(|t| t.as_ref()),
            Some("1000 * TAXRATE")
        );
        // Name is still in the loaded workbook's NameTable.
        assert!(matches!(
            loaded.names().lookup("TAXRATE"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
    }

    /// Phase 2A.6 audit M5 / Phase 2B.2 (2026-05-12): on recompute failure,
    /// the loader must preserve the partially-recomputed workbook so the
    /// caller can inspect / display the partial state. Phase 2B.2 reshapes
    /// this from `LoadAndRecomputeError::Recompute { workbook, error }` to
    /// `Ok((workbook, RecomputeResult { failures, .. }))` — the failure
    /// information moved INTO the RecomputeResult, the workbook always
    /// comes back. Acceptance R2B-04.
    ///
    /// Phase 2A.8 update: named-ranges now persist (audit M12 closed), so the
    /// prior failure trigger (an unresolved named reference after reload) no
    /// longer fails. We force a recompute failure by hand-corrupting the
    /// formula text on-disk to invalid syntax — exercising the same
    /// partial-state preservation path.
    #[test]
    fn recompute_failure_preserves_partial_workbook_in_result() {
        let (_dir, path) = temp_path("partial.qbook");

        // Build a workbook with two formulas, save it, then corrupt one
        // formula's text on-disk so the load → recompute path fails on it.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(42.0));
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 1, 0, "A1 + 1").unwrap();
            rt.set_formula(s, 2, 0, "A1 * 10").unwrap();
        }
        save_workbook(&wb, "partial", &path).unwrap();

        // Corrupt the JSONL for sheet 0 to introduce a parse-broken formula.
        // The JSONL line for (s=0, row=2, col=0) has formula "A1 * 10". We
        // rewrite the file so that line becomes "(((" — guaranteed parse error.
        let jsonl_path = path.join("sheets").join("0.jsonl");
        let original = std::fs::read_to_string(&jsonl_path).unwrap();
        let corrupted = original.replace("A1 * 10", "(((");
        assert_ne!(
            corrupted, original,
            "test setup: expected to corrupt one line"
        );
        std::fs::write(&jsonl_path, corrupted).unwrap();

        let (workbook, result) = load_workbook_and_recompute(&path, &reg).unwrap();
        // Partial workbook is returned; literal A1 intact.
        assert_eq!(workbook.read(Address::new(s, 0, 0)), Value::Number(42.0));
        // Both formula texts survive the load.
        assert_eq!(
            workbook.formula_at(s, 1, 0).map(|t| t.as_ref()),
            Some("A1 + 1")
        );
        assert_eq!(
            workbook.formula_at(s, 2, 0).map(|t| t.as_ref()),
            Some("(((")
        );
        // Recompute aggregate reports the partial state.
        assert!(!result.is_complete());
        assert_eq!(result.attempted, 2);
        assert_eq!(result.succeeded, 1);
        assert_eq!(result.failed_count(), 1);
        // The failure carries the exact corrupted formula text + cell coords.
        let failure = &result.failures[0];
        assert_eq!(failure.sheet, s);
        assert_eq!(failure.row, 2);
        assert_eq!(failure.col, 0);
        assert_eq!(failure.formula_text.as_ref(), "(((");
    }

    /// **W5-105 (Phase 4.7.L)** — full save → load → recompute_all
    /// round-trip for a spilled formula. Acceptance: design § 12.3.
    #[test]
    fn spill_formula_save_load_recompute_round_trip() {
        let (_dir, path) = temp_path("spill-roundtrip.qbook");

        // Build a workbook with A1 = {1, 2, 3} spilling.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 0, 0, "{1, 2, 3}").unwrap();
        }
        // Pre-save: spill should be registered and targets materialized.
        assert_eq!(
            wb.spill_anchor_at(s, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3))
        );
        assert_eq!(wb.read(Address::new(s, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(Address::new(s, 0, 2)), Value::Number(3.0));

        save_workbook(&wb, "spill-roundtrip", &path).unwrap();

        // Load + recompute_all. 4.7.J #128 made recompute_all dispatch
        // top-level arrays through write_spill, so this should re-derive
        // the spill state.
        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
        assert!(result.is_complete(), "recompute failures: {result:?}");
        assert_eq!(result.succeeded, 1, "only A1 has a formula");

        // Post-recompute: spill anchor and targets restored identically.
        assert_eq!(
            loaded.spill_anchor_at(s, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3)),
            "spill anchor must be re-registered by recompute_all"
        );
        assert_eq!(loaded.read(Address::new(s, 0, 0)), Value::Number(1.0));
        assert_eq!(loaded.read(Address::new(s, 0, 1)), Value::Number(2.0));
        assert_eq!(loaded.read(Address::new(s, 0, 2)), Value::Number(3.0));
        assert_eq!(
            loaded.formula_at(s, 0, 0).map(|s| s.as_ref()),
            Some("{1, 2, 3}")
        );
    }

    /// **W5-108 (Phase 4.7.O) — Codex M3 / Sonnet M5 closure**:
    /// `SEQUENCE`-driven spill round-trip. The original 4.7.L test
    /// used a LITERAL array; this variant uses a dynamic-array
    /// function whose result depends on a runtime-coerced arg.
    /// Acceptance: design § 12.3 ("load → recompute → check: the
    /// spill anchor + targets + computed overlays match the pre-save
    /// state").
    #[test]
    fn spill_sequence_formula_round_trip() {
        let (_dir, path) = temp_path("spill-sequence-roundtrip.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 0, 0, "SEQUENCE(4)").unwrap();
        }
        // Pre-save state.
        assert_eq!(
            wb.spill_anchor_at(s, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(4, 1))
        );
        assert_eq!(wb.read(Address::new(s, 3, 0)), Value::Number(4.0));

        save_workbook(&wb, "spill-sequence-roundtrip", &path).unwrap();

        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
        assert!(result.is_complete(), "recompute failures: {result:?}");

        // Post-state matches pre-state.
        assert_eq!(
            loaded.spill_anchor_at(s, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(4, 1))
        );
        for i in 0..4 {
            assert_eq!(
                loaded.read(Address::new(s, i, 0)),
                Value::Number((i + 1) as f64)
            );
        }
        assert_eq!(
            loaded.formula_at(s, 0, 0).map(|s| s.as_ref()),
            Some("SEQUENCE(4)")
        );
    }

    /// **W5-108 (Phase 4.7.O) — Codex M3 / Sonnet M5 closure**:
    /// `TRANSPOSE(NamedRange)` round-trip. The named range table +
    /// the spill anchor table must BOTH survive save/load and the
    /// re-compute must rebuild the spill correctly.
    #[test]
    fn spill_transpose_named_range_round_trip() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let (_dir, path) = temp_path("spill-transpose-named-roundtrip.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.set_name("MyRow", NamedTarget::Range(Range::new(s, 0, 0, 0, 2)))
            .unwrap();
        wb.put(Address::new(s, 0, 0), Value::Number(10.0));
        wb.put(Address::new(s, 0, 1), Value::Number(20.0));
        wb.put(Address::new(s, 0, 2), Value::Number(30.0));
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 5, 0, "TRANSPOSE(MyRow)").unwrap();
        }
        // Pre-save: 1×3 row at (0, 0..2) transposes to 3×1 column at (5, 0).
        assert_eq!(
            wb.spill_anchor_at(s, 5, 0).copied(),
            Some(ql_storage::SpillShape::new(3, 1))
        );

        save_workbook(&wb, "spill-transpose-named-roundtrip", &path).unwrap();

        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
        assert!(result.is_complete(), "recompute failures: {result:?}");

        // Post-state.
        assert_eq!(
            loaded.spill_anchor_at(s, 5, 0).copied(),
            Some(ql_storage::SpillShape::new(3, 1)),
            "TRANSPOSE spill anchor must be re-registered"
        );
        assert_eq!(loaded.read(Address::new(s, 5, 0)), Value::Number(10.0));
        assert_eq!(loaded.read(Address::new(s, 6, 0)), Value::Number(20.0));
        assert_eq!(loaded.read(Address::new(s, 7, 0)), Value::Number(30.0));
        // Named range survived too.
        assert!(loaded.names().lookup_ci("MYROW").is_some());
    }

    /// **FU3 (2026-06-21)** — a LET-body array result that spills must survive
    /// save → load → recompute with full fidelity (anchor formula text + spill
    /// shape + formula-less targets), exactly like a direct `SEQUENCE` spill.
    #[test]
    fn let_spill_formula_save_load_round_trip() {
        let (_dir, path) = temp_path("let-spill-roundtrip.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 0, 0, "LET(x,4,SEQUENCE(x))").unwrap();
        }
        // Pre-save: 4×1 spill at A1:A4, formula only on the anchor.
        assert_eq!(
            wb.spill_anchor_at(s, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(4, 1))
        );
        assert_eq!(wb.read(Address::new(s, 3, 0)), Value::Number(4.0));

        save_workbook(&wb, "let-spill-roundtrip", &path).unwrap();

        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
        assert!(result.is_complete(), "recompute failures: {result:?}");

        assert_eq!(
            loaded.spill_anchor_at(s, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(4, 1)),
            "LET-body spill anchor must be re-registered on load"
        );
        for i in 0..4 {
            assert_eq!(
                loaded.read(Address::new(s, i, 0)),
                Value::Number((i + 1) as f64)
            );
        }
        // The Wave P LET printer re-emits the formula canonicalized (identifiers
        // upper-cased, a space after each comma); the round-trip preserves that
        // normalized text with full fidelity (the input `LET(x,4,SEQUENCE(x))`).
        assert_eq!(
            loaded.formula_at(s, 0, 0).map(|t| t.as_ref()),
            Some("LET(X, 4, SEQUENCE(X))")
        );
        // A spill TARGET carries no formula text (only the anchor does).
        assert_eq!(loaded.formula_at(s, 1, 0), None);
    }
}
