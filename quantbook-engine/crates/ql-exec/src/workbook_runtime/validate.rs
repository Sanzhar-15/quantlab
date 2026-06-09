//! Validation + transaction API for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.8 (2026-05-18, final method-extraction step):
//! extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Two
//! producer-side methods covering IDE on-keystroke validation
//! and multi-cell transaction batching. Pure code move; no
//! behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::transaction`] (Phase 2A.2 / 2A.3.b) — begin
//!   a multi-cell transaction. The returned `WorkbookTransaction`
//!   borrows the runtime's workbook + registry + (optional) op
//!   log for its lifetime; commits land atomically.
//! - [`WorkbookRuntime::validate_formula`] (Phase 2B.7, GAP-I-04
//!   closure) — dry-run the full lex → parse → bind → eval
//!   pipeline against current workbook state without writing.
//!   Used by the IDE for on-keystroke diagnostics. Returns the
//!   would-be evaluated value or a typed `RuntimeError`.

use ql_formula_syntax::{lex, parse};
use ql_types::{ColId, ErrorValue, RowId, SheetId, Value};

use crate::env::WorkbookEnv;
use crate::plan::{bind_with_site, BindSite};
use crate::transaction::WorkbookTransaction;

use super::{validate_cell, RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    /// Begin a multi-cell transaction. The returned `WorkbookTransaction`
    /// borrows the runtime's workbook + registry for its lifetime. Buffer
    /// writes via `put_value`/`put_formula` then call `commit` to apply them
    /// atomically. See `transaction::WorkbookTransaction` for full semantics.
    ///
    /// Phase 2A.3.b (2026-05-12): if the runtime was constructed with
    /// `with_oplog`, the transaction inherits the op-log handle via
    /// `Option::as_deref_mut` (re-borrowed for the transaction's shorter
    /// lifetime). The runtime is borrow-frozen while the transaction is
    /// alive, so a single op log records both individual edits and batched
    /// commits without aliasing.
    pub fn transaction(&mut self) -> WorkbookTransaction<'_> {
        WorkbookTransaction::with_optional_oplog(
            self.workbook,
            self.registry,
            self.oplog.as_deref_mut(),
            // 6.4-3c (CODEX-HIGH-2): forward the session's UDF worker so UDFs
            // committed via a runtime transaction compute, not stale-`#CALC!`.
            self.udf_worker,
            // 6.4B (FF-2): forward the diagnostic collector too, so a UDF failure
            // committed through a runtime transaction emits a `CellDiagnostic`.
            self.udf_diagnostics,
        )
    }

    /// Phase 2B.7 (2026-05-12) — dry-run formula validation for IDE
    /// on-keystroke diagnostics. Runs the full lex → parse → bind → eval
    /// pipeline against the current workbook state, returns the would-be
    /// evaluated value (or `RuntimeError`), but does NOT:
    ///
    /// - write to the workbook,
    /// - append to the op log,
    /// - pollute the bind-plan cache (this avoids a transient cache entry
    ///   keyed on a formula text the user hasn't actually committed —
    ///   would inflate the cache miss count and waste a `name_gen` slot).
    ///
    /// Use case: the IDE wants to highlight syntax errors as the user types
    /// in the formula bar, without committing the formula until Enter.
    /// Each keystroke can call `validate_formula(sheet, row, col, draft)`
    /// safely — N calls per keystroke add no engine state.
    ///
    /// Closes GAP-I-04 from `docs/known-gaps.md`.
    pub fn validate_formula(
        &self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &str,
    ) -> Result<Value, RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        let tokens = lex(formula_text)?;
        let expr = parse(tokens)?;
        // W5-92 (Phase 4.6.D): pass `&Workbook` for names so the
        // two-tier sheet-then-workbook scope chain fires.
        // **W5-114 (Phase 4.8.E):** carry the (proposed) cell address so
        // structured-ref `[@Col]` validation works.
        let plan = bind_with_site(
            &expr,
            BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
            self.workbook,
            self.workbook,
            self.workbook,
            self.registry,
        )?;
        // **W5-117 (Phase 4.8.G.2):** carry cell for `[@Col]` narrowing.
        let env =
            WorkbookEnv::with_formula_cell(self.workbook, ql_types::Address::new(sheet, row, col));
        // **W5-103 megaudit MEDIUM-3 closure (#129):** route through
        // `eval_at_cell_boundary` so a top-level array literal like
        // `{1, 2, 3}` returns the anchor value (array.at(0,0)) instead
        // of `#CALC!` (which is what `eval_scalar_with_registry` would
        // give per the scalar-context contract at scalar.rs:95).
        //
        // Previously the validate path used scalar eval directly, which
        // made the IDE preview inconsistent with `set_formula`'s actual
        // spill behavior. With this change, validate and set_formula
        // produce equivalent anchor-value previews. The IDE doesn't get
        // the SHAPE of the spill from validate; that would need a
        // dedicated `ValidationResult` enum (deferred — see GAP-I-04).
        let nc = crate::aggregate_cache::NoAggregateCache;
        let result = crate::scalar::eval_at_cell_boundary(&plan, &env, self.registry, &nc);
        Ok(match result {
            crate::eval_result::EvalResult::Scalar(v) => v,
            // Anchor cell preview = array.at(0,0). Degenerate arrays
            // surface as `#CALC!` per the existing scalar-context
            // contract (preserved via `into_scalar_for_test`-style
            // logic inlined here to avoid the cfg(test) gate).
            crate::eval_result::EvalResult::Array(a) if a.is_degenerate() => {
                Value::Error(ErrorValue::Calc)
            }
            crate::eval_result::EvalResult::Array(a) => a.at(0, 0).clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use ql_functions::{default_registry, FunctionRegistry};
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value};

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    /// **6.4-1 (2026-05-28; H1):** shared default registry — see
    /// `crates/ql-exec/src/plan.rs::tests::TEST_REGISTRY` for the
    /// pattern. The W5-D-13.1 / aggregate-list invariant tests still
    /// pin the matcher; the matcher now reads metadata so they look up
    /// against this same default registry instance.
    static TEST_REGISTRY: LazyLock<FunctionRegistry> = LazyLock::new(default_registry);

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // (`add_sheet_rejects_zero_chunk_rows` moved to `sheets.rs::tests`;
    // `clear_formula_rejects_*` moved to `cells.rs::tests` per Tier D1
    // audit Codex L-2/L-3 D1.a re-partitioning.)

    /// Phase 2B.7 (closes GAP-I-04): `validate_formula` runs the full
    /// pipeline but doesn't mutate the workbook or the op log. The IDE
    /// can call it on every keystroke to surface diagnostics without
    /// committing the user's draft.
    #[test]
    fn validate_formula_returns_value_without_writing() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        use ql_oplog::OpLog;
        let mut oplog = OpLog::new();
        let rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

        let v = rt.validate_formula(0, 1, 0, "A1 * 5").unwrap();
        assert_eq!(v, Value::Number(50.0));

        // Workbook UNCHANGED: cell (1, 0) is still Blank, no formula
        // associated.
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Blank);
        assert!(wb.formula_at(0, 1, 0).is_none());
        // Op log untouched.
        assert!(oplog.is_empty());
    }

    /// `validate_formula` surfaces bind errors the same way `set_formula`
    /// does — the IDE renders the same Display strings.
    #[test]
    fn validate_formula_surfaces_bind_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.validate_formula(0, 0, 0, "(1 + 2");
        assert!(matches!(result, Err(RuntimeError::Parse(_))));
        // No state change.
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// **W5-103 megaudit MEDIUM-3 closure (#129):** `validate_formula`
    /// on a top-level array literal must return the anchor value
    /// (array.at(0,0)), NOT `#CALC!`. Pre-fix the scalar-context
    /// `eval_scalar_with_registry` path gave #CALC! for arrays,
    /// making the IDE preview inconsistent with `set_formula`'s
    /// actual spill behavior.
    #[test]
    fn validate_formula_returns_anchor_value_for_top_level_array() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let rt = WorkbookRuntime::new(&mut wb, &reg);
        // Horizontal: {1, 2, 3} — anchor is array.at(0,0) = Number(1).
        let v = rt.validate_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        assert_eq!(
            v,
            Value::Number(1.0),
            "validate_formula on array literal must give anchor value"
        );
        // Vertical: {7; 8} — anchor is Number(7).
        let v = rt.validate_formula(0, 0, 0, "{7; 8}").unwrap();
        assert_eq!(v, Value::Number(7.0));
        // 2x2: {1, 2; 3, 4} — anchor is Number(1).
        let v = rt.validate_formula(0, 0, 0, "{1, 2; 3, 4}").unwrap();
        assert_eq!(v, Value::Number(1.0));
        // No state mutation (validate is read-only).
        assert!(wb.formula_at(0, 0, 0).is_none());
        assert!(wb.spill_anchor_at(0, 0, 0).is_none());
    }

    /// `validate_formula` does NOT pollute the bind-plan cache. A
    /// keystroke-driven validate of a half-typed formula must not insert
    /// a cache entry that would mismatch when the user finally hits Enter.
    #[test]
    fn validate_formula_does_not_pollute_plan_cache() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(2.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Validate several drafts. The cache stays empty.
        let _ = rt.validate_formula(0, 1, 0, "A1 + 1").unwrap();
        let _ = rt.validate_formula(0, 1, 0, "A1 + 2").unwrap();
        let _ = rt.validate_formula(0, 1, 0, "A1 + 3").unwrap();
        assert_eq!(rt.cache_stats().entries, 0);
        assert_eq!(rt.cache_stats().hits, 0);
        assert_eq!(rt.cache_stats().misses, 0);

        // A real set_formula DOES populate the cache.
        rt.set_formula(0, 1, 0, "A1 + 3").unwrap();
        assert_eq!(rt.cache_stats().entries, 1);
    }

    /// Phase 2B.7 audit (correctness M1): `is_aggregate_function` must
    /// only list functions actually registered. Cross-check against the
    /// default registry; a mismatch means the binder will surface
    /// `NamedRangeInScalarContext` for what looked like a valid aggregate
    /// (or vice versa).
    #[test]
    fn is_aggregate_function_lists_only_registered_aggregates() {
        let reg = default_registry();
        // Every name `is_aggregate_function` recognizes must exist in the
        // registry. Hardcoded names (mirror the matcher in plan.rs).
        for name in &[
            "SUM", "AVERAGE", "AVG", "COUNT", "COUNTA", "MIN", "MAX", "PRODUCT", "VAR", "VAR.S",
            "VAR.P", "STDEV", "STDEV.S", "STDEV.P",
        ] {
            assert!(
                reg.lookup(name).is_some(),
                "is_aggregate_function lists {name:?} but it's not in default_registry"
            );
        }
        // W5-53 (GAP-F-05 closure) + W5-54 (lookup family): range-
        // aware names are also in is_aggregate_function but live in
        // the parallel range_aware_fns table; check via
        // lookup_range_aware.
        for name in &[
            "SUMIF",
            "COUNTIF",
            "MATCH",
            "INDEX",
            "VLOOKUP",
            "HLOOKUP",
            "CHOOSE",
            "AVERAGEIF",
            "SUMIFS",
            "COUNTIFS",
            "AVERAGEIFS",
            "SUMPRODUCT",
            "LARGE",
            "SMALL",
            "RANK",
            "RANK.EQ",
            // W5-62 audit closure (Codex M2 / Sonnet H1): the
            // invariant test had drifted out of sync with the
            // is_aggregate_function whitelist. RANK.AVG + CONCAT
            // landed W5-61 but weren't pinned here.
            "RANK.AVG",
            "MEDIAN",
            "MODE",
            "MODE.SNGL",
            "CONCAT",
            // **W5-D-12 (Phase 4.10 V1-260 sealer) — Codex HIGH-001
            // closure:** SUBTOTAL is range-aware (dispatches to scalar
            // aggregates based on function_num) and admitted to
            // is_aggregate_function so range args bind as
            // AggregateNameRef. Eval-side routes via lookup_range_aware.
            "SUBTOTAL",
            // **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure):**
            // 28 additional range-aware fns admitted to
            // is_aggregate_function in one batch — the same systemic
            // gap the W5-D-12 closure caught only for SUBTOTAL. Per
            // megaudit Codex HIGH-001 + Opus HIGH-1.
            "CORREL",
            "PEARSON",
            "RSQ",
            "STEYX",
            "SLOPE",
            "INTERCEPT",
            "COVARIANCE.P",
            "COVARIANCE.S",
            "SUMX2MY2",
            "SUMX2PY2",
            "SUMXMY2",
            "NPV",
            "IRR",
            "MIRR",
            "XNPV",
            "XIRR",
            "XLOOKUP",
            "XMATCH",
            "PERCENTILE.INC",
            "PERCENTILE.EXC",
            "PERCENTILE",
            "QUARTILE.INC",
            "QUARTILE.EXC",
            "QUARTILE",
            "MINIFS",
            "MAXIFS",
            "COUNTBLANK",
            "TEXTJOIN",
            // B2 (native quant fns) — range-aware quant aggregates.
            "SHARPE",
            "MAX_DRAWDOWN",
        ] {
            assert!(
                reg.lookup_range_aware(name).is_some(),
                "is_aggregate_function lists {name:?} (range-aware variant) but \
                 it's not in default_registry's range_aware_fns table"
            );
            assert!(
                reg.lookup(name).is_none(),
                "{name:?} is range-aware ONLY; must not also appear in the scalar table"
            );
        }
        // W5-107-AUDIT (Phase 4.7.N — Codex HIGH closure): unified-ABI
        // array-returning functions that also appear in
        // is_aggregate_function so the binder routes named-range args
        // through Range context instead of surfacing
        // NamedRangeInScalarContext. They live in unified_fns, not
        // scalar/range_aware tables.
        for name in &["TRANSPOSE", "FILTER"] {
            assert!(
                reg.lookup_unified(name).is_some(),
                "is_aggregate_function lists {name:?} (unified variant) but \
                 it's not in default_registry's unified_fns table"
            );
            assert!(
                reg.lookup(name).is_none(),
                "{name:?} is unified ONLY; must not appear in the scalar table"
            );
            assert!(
                reg.lookup_range_aware(name).is_none(),
                "{name:?} is unified ONLY; must not appear in the range-aware table"
            );
        }
        // Sanity: a known non-aggregate (IF) is in the registry but
        // is_aggregate_function does NOT claim it. We can't directly call
        // is_aggregate_function (private), but we can verify via behavior:
        // a NameRef to a range used inside IF surfaces
        // NamedRangeInScalarContext (since IF's args are scalar context).
        // That behaviour is pinned by `nag_04_named_range_in_scalar_positions_errors_precisely`.
    }

    /// **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex HIGH-001,
    /// Opus HIGH-1 / HIGH-3):** prove that the 28 range-aware fns
    /// admitted to `is_aggregate_function` in this closure actually
    /// route range args through `AggregateNameRef` end-to-end, not just
    /// pass the registry-lookup smoke test. This is the e2e armor the
    /// W5-D-12 SUBTOTAL closure should have had but didn't, scaled to
    /// cover the systemic case.
    ///
    /// Each test sets up a named range, then drives a formula through
    /// `set_formula` (which exercises lex → parse → bind → eval). A
    /// pre-W5-D-13.1 build would fail every one of these with
    /// `Bind(NamedRangeInScalarContext("SALES"))`.
    #[test]
    fn w5_d_13_1_subtotal_named_range_binds_and_evaluates() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_at(0, 1, 0, Value::Number(2.0));
        wb.put_at(0, 2, 0, Value::Number(3.0));
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 0, 0, 2, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // SUBTOTAL(9, Sales) = SUM(Sales) = 6. The Codex W5-D-12
        // HIGH-001 closure recommendation that was never shipped.
        let v = rt.set_formula(0, 5, 0, "SUBTOTAL(9, Sales)").unwrap();
        assert_eq!(v, Value::Number(6.0));
        // SUBTOTAL(1, Sales) = AVERAGE(Sales) = 2.
        let v = rt.set_formula(0, 5, 1, "SUBTOTAL(1, Sales)").unwrap();
        assert_eq!(v, Value::Number(2.0));
    }

    #[test]
    fn w5_d_13_1_percentile_quartile_named_range_binds_and_evaluates() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        for i in 0..4 {
            wb.put_at(0, i as u32, 0, Value::Number((i + 1) as f64));
        }
        wb.set_name("Data", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // PERCENTILE.INC(Data, 0.3) = 1.9 (Microsoft anchor).
        let v = rt
            .set_formula(0, 5, 0, "PERCENTILE.INC(Data, 0.3)")
            .unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.9).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(1.9), got {other:?}"),
        }
        // PERCENTILE.EXC(Data, 0.25) = 1.25.
        let v = rt
            .set_formula(0, 5, 1, "PERCENTILE.EXC(Data, 0.25)")
            .unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.25).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(1.25), got {other:?}"),
        }
        // QUARTILE.INC(Data, 2) = median = 2.5.
        let v = rt.set_formula(0, 5, 2, "QUARTILE.INC(Data, 2)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 2.5).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(2.5), got {other:?}"),
        }
        // Legacy alias PERCENTILE (Excel 2010+) matches .INC.
        let v = rt.set_formula(0, 5, 3, "PERCENTILE(Data, 0.3)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.9).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(1.9), got {other:?}"),
        }
    }

    #[test]
    fn w5_d_13_1_paired_array_stats_named_range_binds_and_evaluates() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        // X = [1, 2, 3, 4]; Y = [2, 4, 6, 8] — perfect linear y=2x.
        for i in 0..4 {
            wb.put_at(0, i as u32, 0, Value::Number((i + 1) as f64));
            wb.put_at(0, i as u32, 1, Value::Number(((i + 1) * 2) as f64));
        }
        // **Note**: name must NOT collide with valid Excel column-letter
        // patterns (e.g. `Ys` lexes as BareColumn col=668). Use names
        // with >3 letters or underscores. `XValues`/`YValues` are safe.
        wb.set_name("XValues", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
            .unwrap();
        wb.set_name("YValues", NamedTarget::Range(Range::new(0, 0, 1, 3, 1)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // CORREL(YValues, XValues) = 1.0 (perfect positive correlation).
        let v = rt.set_formula(0, 5, 0, "CORREL(YValues, XValues)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(1.0), got {other:?}"),
        }
        // SLOPE(YValues, XValues) = 2.0.
        let v = rt.set_formula(0, 5, 1, "SLOPE(YValues, XValues)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 2.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(2.0), got {other:?}"),
        }
        // COVARIANCE.P(XValues, YValues) = 2.5.
        let v = rt
            .set_formula(0, 5, 2, "COVARIANCE.P(XValues, YValues)")
            .unwrap();
        match v {
            Value::Number(n) => assert!((n - 2.5).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(2.5), got {other:?}"),
        }
        // PEARSON(YValues, XValues) = 1.0 (alias of CORREL).
        let v = rt
            .set_formula(0, 5, 3, "PEARSON(YValues, XValues)")
            .unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(1.0), got {other:?}"),
        }
    }

    #[test]
    fn w5_d_13_1_atan2_and_sumxmy2_via_source_text() {
        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex HIGH-002
        // / Opus HIGH-2):** the lexer letters>3+digit Ident-fallback
        // makes ATAN2, SUMXMY2, and DAYS360 reachable from formula
        // source text. End-to-end test via `set_formula`.
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        for i in 0..3 {
            wb.put_at(0, i as u32, 0, Value::Number((i + 1) as f64));
            wb.put_at(0, i as u32, 1, Value::Number((i + 1) as f64));
        }
        wb.set_name("XData", NamedTarget::Range(Range::new(0, 0, 0, 2, 0)))
            .unwrap();
        wb.set_name("YData", NamedTarget::Range(Range::new(0, 0, 1, 2, 1)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // ATAN2(1, 0) = 0 (angle along +x axis; Excel arg order x, y).
        let v = rt.set_formula(0, 5, 0, "ATAN2(1, 0)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 0.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(0.0), got {other:?}"),
        }
        // SUMXMY2(XData, YData) = 0 (XData == YData, so squared diffs = 0).
        let v = rt.set_formula(0, 5, 1, "SUMXMY2(XData, YData)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 0.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(0.0), got {other:?}"),
        }
    }

    /// **B2 (native quant fns) — full-path lex→parse→bind→eval armor for
    /// `=SHARPE(...)`.** This is the test the audit rule (#3: range-aware fns
    /// need coverage at all four stages) requires beyond the direct unit
    /// tests in `ql-functions`. A named range over the data is typed into a
    /// formula, recalc runs, and the cell value is asserted — the SAME path
    /// every existing range-aware aggregate e2e test uses (SUBTOTAL, CORREL,
    /// PERCENTILE.* in `w5_d_13_1_*`).
    ///
    /// A pre-B2 build (missing the `ArgContext::Aggregate` admission in the
    /// Phase-1.5 override list) would route the named range through
    /// `BindContext::Scalar` and surface `Bind(NamedRangeInScalarContext)`
    /// rather than binding the `AggregateNameRef`. So this test IS the
    /// bind-step armor the Codex correction called for.
    ///
    /// **Engine note (W2-literal-range, 2026-06-09):** a *literal* colon
    /// range (`=SHARPE(A1:A4)`) now ALSO binds + evaluates — the binder
    /// lowers a literal `Expr::RangeRef` in `BindContext::AggregateArg` to
    /// `ExprPlan::RangeRef { range }` (same downstream shape as a named
    /// range), engine-global for EVERY aggregate (`SUM(A1:A4)` too). This
    /// test keeps the named-range path as the reference; the literal-range
    /// equivalence is pinned by
    /// `b2_literal_range_arg_to_aggregate_now_binds_and_evaluates` below.
    #[test]
    fn b2_sharpe_full_path_named_range() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        // Returns series in A1:A4 = [0.01, 0.02, 0.03, 0.04].
        wb.put_at(0, 0, 0, Value::Number(0.01));
        wb.put_at(0, 1, 0, Value::Number(0.02));
        wb.put_at(0, 2, 0, Value::Number(0.03));
        wb.put_at(0, 3, 0, Value::Number(0.04));
        wb.set_name("Returns", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // mean=0.025, sample stdev=sqrt(0.0005/3)=0.0129099445,
        // SHARPE (Rf=0) = 1.9364916731.
        let v = rt.set_formula(0, 0, 5, "SHARPE(Returns)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.9364916731).abs() < 1e-9, "got {n}"),
            other => panic!("expected Number(~1.9365), got {other:?}"),
        }

        // With a risk-free rate: (0.025-0.01)/0.0129099445 = 1.1618950039.
        let v = rt.set_formula(0, 1, 5, "SHARPE(Returns, 0.01)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.1618950039).abs() < 1e-9, "got {n}"),
            other => panic!("expected Number(~1.1619), got {other:?}"),
        }

        // With sqrt-periods annualization: 1.9364916731*sqrt(4)=3.8729833462.
        let v = rt.set_formula(0, 2, 5, "SHARPE(Returns, 0, 4)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 3.8729833462).abs() < 1e-9, "got {n}"),
            other => panic!("expected Number(~3.8730), got {other:?}"),
        }
    }

    /// **B2 (native quant fns) — full-path armor for `=MAX_DRAWDOWN(...)`.**
    /// Doubles as proof the lexer admits the underscore-bearing function name
    /// (`MAX_DRAWDOWN` is letters+`_`, consumed as one Ident) — without that,
    /// it would never reach the binder. Uses the named-range path (see the
    /// engine note on `b2_sharpe_full_path_named_range`).
    #[test]
    fn b2_max_drawdown_full_path_named_range() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        // Equity series A1:A6 = [100, 120, 90, 110, 80, 130].
        let prices = [100.0, 120.0, 90.0, 110.0, 80.0, 130.0];
        for (i, p) in prices.iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Number(*p));
        }
        wb.set_name("Equity", NamedTarget::Range(Range::new(0, 0, 0, 5, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // MDD = 80/120 - 1 = -1/3.
        let v = rt.set_formula(0, 0, 5, "MAX_DRAWDOWN(Equity)").unwrap();
        match v {
            Value::Number(n) => assert!((n - (-1.0 / 3.0)).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(~-0.3333), got {other:?}"),
        }
    }

    /// **B2 — full-path error contract (named-range path).** Empty range ⇒
    /// `#NUM!`; a single-cell range to SHARPE ⇒ `#DIV/0!` (n<2 sample stdev
    /// undefined). Pins that the No-Fallbacks error semantics survive the
    /// bind+eval round-trip.
    #[test]
    fn b2_sharpe_max_drawdown_error_contract_full_path() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        // A1 holds the only value; A10:A12 are left blank → empty range.
        wb.put_at(0, 0, 0, Value::Number(0.05));
        // **Note (W5-D-13.1 gotcha):** named ranges must use >3-letter names
        // or they lex as a BareColumn (a whole-column literal range) instead
        // of a NameRef. `Single` / `EmptyRng` are safe; a 3-letter name like
        // `One` would lex as column `ONE` → literal RangeRef → unsupported.
        wb.set_name("Single", NamedTarget::Range(Range::new(0, 0, 0, 0, 0)))
            .unwrap();
        wb.set_name("EmptyRng", NamedTarget::Range(Range::new(0, 9, 0, 11, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Single-cell range to SHARPE → n=1 → #DIV/0!.
        let v = rt.set_formula(0, 0, 5, "SHARPE(Single)").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::DivZero));

        // All-blank range → 0 numeric values → #NUM! for both.
        let v = rt.set_formula(0, 1, 5, "SHARPE(EmptyRng)").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::Num));
        let v = rt.set_formula(0, 2, 5, "MAX_DRAWDOWN(EmptyRng)").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::Num));
    }

    /// **B2 / W2-literal-range (2026-06-09) — a literal colon range argument
    /// to an aggregate now BINDS and EVALUATES.** This was previously a
    /// pre-existing v1 limitation (`b2_literal_range_arg_to_aggregate_is_
    /// unsupported_pre_existing`, which asserted REJECTION); the W2 binder +
    /// dispatcher change lifts it. The binder now lowers a literal
    /// `Expr::RangeRef` in `BindContext::AggregateArg` to
    /// `ExprPlan::RangeRef { range }` (the same downstream shape an
    /// `AggregateNameRef` produces), and every scalar / range-aware / unified
    /// dispatcher arm reads it as a `FnArg::Range` / `FunctionArg::Range`.
    /// We pin the SUCCESS here for both SHARPE (RangeAware tier) and SUM
    /// (Scalar tier) to prove the literal-range surface — the exact
    /// `=SHARPE(A1:A10)` / `=SUM(A1:A4)` shape — is now live engine-global.
    #[test]
    fn b2_literal_range_arg_to_aggregate_now_binds_and_evaluates() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(0.01));
        wb.put_at(0, 1, 0, Value::Number(0.02));
        wb.put_at(0, 2, 0, Value::Number(0.03));
        wb.put_at(0, 3, 0, Value::Number(0.04));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Literal `A1:A4` in aggregate-arg position now binds + evaluates.
        // SHARPE over [0.01,0.02,0.03,0.04]: mean=0.025,
        // sample stdev=sqrt(0.0005/3)=0.0129099445, SHARPE(Rf=0)=1.9364916731
        // — IDENTICAL to the named-range path (`b2_sharpe_full_path_named_range`).
        let v = rt.set_formula(0, 0, 5, "SHARPE(A1:A4)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.9364916731).abs() < 1e-9, "got {n}"),
            other => panic!("expected Number(~1.9365), got {other:?}"),
        }

        // `SUM(A1:A4)` — a builtin Scalar-tier aggregate — also binds:
        // 0.01+0.02+0.03+0.04 = 0.10.
        let sum = rt.set_formula(0, 1, 5, "SUM(A1:A4)").unwrap();
        match sum {
            Value::Number(n) => assert!((n - 0.10).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(0.10), got {other:?}"),
        }
    }

    /// **W2-literal-range — Scalar-tier aggregates over a literal range
    /// (SUM / AVERAGE / COUNT / MIN / MAX).** Full lex→parse→bind→eval; the
    /// computed VALUE is asserted (not just that it binds). The data lives in
    /// A1:A5 = [1, 2, 3, 4, 5].
    #[test]
    fn w2_literal_range_scalar_aggregates_full_path() {
        let mut wb = make_runtime_workbook();
        for (i, v) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Number(*v));
        }
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        assert_eq!(
            rt.set_formula(0, 0, 5, "SUM(A1:A5)").unwrap(),
            Value::Number(15.0)
        );
        assert_eq!(
            rt.set_formula(0, 1, 5, "AVERAGE(A1:A5)").unwrap(),
            Value::Number(3.0)
        );
        assert_eq!(
            rt.set_formula(0, 2, 5, "COUNT(A1:A5)").unwrap(),
            Value::Number(5.0)
        );
        assert_eq!(
            rt.set_formula(0, 3, 5, "MIN(A1:A5)").unwrap(),
            Value::Number(1.0)
        );
        assert_eq!(
            rt.set_formula(0, 4, 5, "MAX(A1:A5)").unwrap(),
            Value::Number(5.0)
        );

        // Multi-range literal aggregate: SUM(A1:A2, A4:A5) = 1+2+4+5 = 12.
        assert_eq!(
            rt.set_formula(0, 5, 5, "SUM(A1:A2, A4:A5)").unwrap(),
            Value::Number(12.0)
        );
        // Mixed literal-range + scalar arg: SUM(A1:A5, 100) = 115.
        assert_eq!(
            rt.set_formula(0, 6, 5, "SUM(A1:A5, 100)").unwrap(),
            Value::Number(115.0)
        );
    }

    /// **W2-literal-range — RangeAware-tier quant fns (SHARPE / MAX_DRAWDOWN)
    /// over a literal range.** These resolve BEFORE the Scalar arms, so this
    /// exercises the RangeAware dispatch arm specifically. Values match the
    /// named-range full-path tests exactly.
    #[test]
    fn w2_literal_range_range_aware_quant_fns_full_path() {
        let mut wb = make_runtime_workbook();
        // Equity series A1:A6 = [100, 120, 90, 110, 80, 130] for MAX_DRAWDOWN.
        for (i, p) in [100.0, 120.0, 90.0, 110.0, 80.0, 130.0].iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Number(*p));
        }
        // Returns series B1:B4 = [0.01, 0.02, 0.03, 0.04] for SHARPE.
        for (i, r) in [0.01, 0.02, 0.03, 0.04].iter().enumerate() {
            wb.put_at(0, i as u32, 1, Value::Number(*r));
        }
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // MAX_DRAWDOWN(A1:A6) = 80/120 - 1 = -1/3 (matches named-range path).
        let mdd = rt.set_formula(0, 0, 5, "MAX_DRAWDOWN(A1:A6)").unwrap();
        match mdd {
            Value::Number(n) => assert!((n - (-1.0 / 3.0)).abs() < 1e-12, "got {n}"),
            other => panic!("expected ~-0.3333, got {other:?}"),
        }

        // SHARPE(B1:B4) = 1.9364916731 (matches named-range path).
        let sh = rt.set_formula(0, 1, 5, "SHARPE(B1:B4)").unwrap();
        match sh {
            Value::Number(n) => assert!((n - 1.9364916731).abs() < 1e-9, "got {n}"),
            other => panic!("expected ~1.9365, got {other:?}"),
        }

        // SHARPE with a risk-free-rate scalar arg ALONGSIDE the literal range:
        // (0.025-0.01)/0.0129099445 = 1.1618950039.
        let sh_rf = rt.set_formula(0, 2, 5, "SHARPE(B1:B4, 0.01)").unwrap();
        match sh_rf {
            Value::Number(n) => assert!((n - 1.1618950039).abs() < 1e-9, "got {n}"),
            other => panic!("expected ~1.1619, got {other:?}"),
        }
    }

    /// **W2-literal-range — the *IF* family with literal ranges, INCLUDING
    /// the criteria-arg safety contract.** SUMIF / COUNTIF / AVERAGEIF /
    /// SUMIFS read their range slots as `FnArg::Range`. CRITICAL: a literal
    /// range handed to the CRITERIA slot must surface `#VALUE!`, NOT panic —
    /// each impl explicitly pattern-matches `FnArg::Range` in the criteria
    /// position and returns `Value::Error(ErrorValue::Value)`. This test
    /// pins that no-panic contract.
    #[test]
    fn w2_literal_range_if_family_full_path_incl_criteria_safety() {
        let mut wb = make_runtime_workbook();
        // A1:A5 = [1, 2, 3, 4, 5]; B1:B5 = [10, 20, 30, 40, 50].
        for (i, v) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Number(*v));
        }
        for (i, v) in [10.0, 20.0, 30.0, 40.0, 50.0].iter().enumerate() {
            wb.put_at(0, i as u32, 1, Value::Number(*v));
        }
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // COUNTIF(A1:A5, ">2") = {3,4,5} = 3.
        assert_eq!(
            rt.set_formula(0, 0, 5, "COUNTIF(A1:A5, \">2\")").unwrap(),
            Value::Number(3.0)
        );
        // SUMIF(A1:A5, ">2") = 3+4+5 = 12.
        assert_eq!(
            rt.set_formula(0, 1, 5, "SUMIF(A1:A5, \">2\")").unwrap(),
            Value::Number(12.0)
        );
        // SUMIF(A1:A5, ">2", B1:B5) = 30+40+50 = 120 (both literal ranges).
        assert_eq!(
            rt.set_formula(0, 2, 5, "SUMIF(A1:A5, \">2\", B1:B5)")
                .unwrap(),
            Value::Number(120.0)
        );
        // AVERAGEIF(A1:A5, ">2", B1:B5) = (30+40+50)/3 = 40.
        assert_eq!(
            rt.set_formula(0, 3, 5, "AVERAGEIF(A1:A5, \">2\", B1:B5)")
                .unwrap(),
            Value::Number(40.0)
        );
        // SUMIFS(B1:B5, A1:A5, ">2") = 120 (sum_range FIRST in IFS canon).
        assert_eq!(
            rt.set_formula(0, 4, 5, "SUMIFS(B1:B5, A1:A5, \">2\")")
                .unwrap(),
            Value::Number(120.0)
        );
        // COUNTIFS(A1:A5, ">2") = {3,4,5} = 3.
        assert_eq!(
            rt.set_formula(0, 8, 5, "COUNTIFS(A1:A5, \">2\")").unwrap(),
            Value::Number(3.0)
        );
        // AVERAGEIFS(B1:B5, A1:A5, ">2") = (30+40+50)/3 = 40.
        assert_eq!(
            rt.set_formula(0, 9, 5, "AVERAGEIFS(B1:B5, A1:A5, \">2\")")
                .unwrap(),
            Value::Number(40.0)
        );
        // MINIFS(B1:B5, A1:A5, ">2") = min(30,40,50) = 30.
        assert_eq!(
            rt.set_formula(0, 10, 5, "MINIFS(B1:B5, A1:A5, \">2\")")
                .unwrap(),
            Value::Number(30.0)
        );
        // MAXIFS(B1:B5, A1:A5, ">2") = max(30,40,50) = 50.
        assert_eq!(
            rt.set_formula(0, 11, 5, "MAXIFS(B1:B5, A1:A5, \">2\")")
                .unwrap(),
            Value::Number(50.0)
        );

        // CRITICAL safety: a literal range in the CRITERIA slot must NOT
        // panic — it binds to FnArg::Range and the impl returns #VALUE!.
        // `COUNTIF(A1:A5, B1:B5)` — B1:B5 is a non-Excel range criteria.
        assert_eq!(
            rt.set_formula(0, 5, 5, "COUNTIF(A1:A5, B1:B5)").unwrap(),
            Value::Error(ErrorValue::Value)
        );
        // `SUMIF(A1:A5, B1:B5, B1:B5)` — criteria slot is a range.
        assert_eq!(
            rt.set_formula(0, 6, 5, "SUMIF(A1:A5, B1:B5, B1:B5)")
                .unwrap(),
            Value::Error(ErrorValue::Value)
        );
        // `SUMIFS(B1:B5, A1:A5, B1:B5)` — IFS criteria slot is a range.
        assert_eq!(
            rt.set_formula(0, 7, 5, "SUMIFS(B1:B5, A1:A5, B1:B5)")
                .unwrap(),
            Value::Error(ErrorValue::Value)
        );
        // The remaining IFS variants share `parse_ifs_pairs`, but pin each
        // explicitly so a future refactor can't regress criteria safety.
        // `COUNTIFS(A1:A5, B1:B5)` — criteria slot is a range.
        assert_eq!(
            rt.set_formula(0, 12, 5, "COUNTIFS(A1:A5, B1:B5)").unwrap(),
            Value::Error(ErrorValue::Value)
        );
        // `AVERAGEIFS(B1:B5, A1:A5, B1:B5)` — criteria slot is a range.
        assert_eq!(
            rt.set_formula(0, 13, 5, "AVERAGEIFS(B1:B5, A1:A5, B1:B5)")
                .unwrap(),
            Value::Error(ErrorValue::Value)
        );
        // `MINIFS(B1:B5, A1:A5, B1:B5)` — criteria slot is a range.
        assert_eq!(
            rt.set_formula(0, 14, 5, "MINIFS(B1:B5, A1:A5, B1:B5)")
                .unwrap(),
            Value::Error(ErrorValue::Value)
        );
        // `MAXIFS(B1:B5, A1:A5, B1:B5)` — criteria slot is a range.
        assert_eq!(
            rt.set_formula(0, 15, 5, "MAXIFS(B1:B5, A1:A5, B1:B5)")
                .unwrap(),
            Value::Error(ErrorValue::Value)
        );
    }

    /// **W2-literal-range — SUBTOTAL with a literal range.** SUBTOTAL is
    /// range-aware (dispatches `function_num` to a scalar aggregate); the
    /// W5-D-12.1 closure only admitted the NAMED-range form. With the W2
    /// binder open, `SUBTOTAL(9, A1:A3)` now binds the literal range too.
    #[test]
    fn w2_literal_range_subtotal_full_path() {
        let mut wb = make_runtime_workbook();
        for (i, v) in [10.0, 20.0, 30.0].iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Number(*v));
        }
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // SUBTOTAL(9, A1:A3) = SUM = 60.
        assert_eq!(
            rt.set_formula(0, 0, 5, "SUBTOTAL(9, A1:A3)").unwrap(),
            Value::Number(60.0)
        );
        // SUBTOTAL(1, A1:A3) = AVERAGE = 20.
        assert_eq!(
            rt.set_formula(0, 1, 5, "SUBTOTAL(1, A1:A3)").unwrap(),
            Value::Number(20.0)
        );
    }

    /// **W2-literal-range — a CROSS-SHEET literal range (`S2!A1:A4`).** The
    /// `resolve_sheet_ref` path inside `resolve_range_ref_to_range` resolves
    /// the sheet by name; the aggregate then reads cells from the OTHER
    /// sheet. Proves the literal-range binder is sheet-qualified.
    #[test]
    fn w2_literal_range_cross_sheet_full_path() {
        let mut wb = make_runtime_workbook(); // adds "S" at index 0.
        let s2 = wb.add_sheet("S2");
        // S2!A1:A4 = [2, 4, 6, 8]; sum = 20, average = 5.
        for (i, v) in [2.0, 4.0, 6.0, 8.0].iter().enumerate() {
            wb.put_at(s2, i as u32, 0, Value::Number(*v));
        }
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Formula lives on sheet S (index 0), references S2's literal range.
        assert_eq!(
            rt.set_formula(0, 0, 5, "SUM(S2!A1:A4)").unwrap(),
            Value::Number(20.0)
        );
        assert_eq!(
            rt.set_formula(0, 1, 5, "AVERAGE(S2!A1:A4)").unwrap(),
            Value::Number(5.0)
        );
        // An unknown sheet in a literal range fails LOUD at bind (no silent
        // fallback) — `BindError::UnknownSheet`.
        let err = rt.set_formula(0, 2, 5, "SUM(Nope!A1:A4)").unwrap_err();
        let msg = format!("{err:?}");
        assert!(
            msg.contains("UnknownSheet"),
            "expected UnknownSheet for a bad sheet in a literal range, got: {msg}"
        );
    }

    /// **W2-literal-range — a WHOLE-COLUMN literal range (`A:A`).** A bare
    /// column lexes as `RangeRef::WholeColumn`, resolving to a range with
    /// `end_row = MAX_ROW`; `read_range` clamps to populated bounds, so
    /// `SUM(A:A)` scans only the populated cells (no 4-billion-row hang).
    #[test]
    fn w2_literal_range_whole_column_full_path() {
        let mut wb = make_runtime_workbook();
        // A1:A3 = [10, 20, 30]; rest of column A is blank.
        for (i, v) in [10.0, 20.0, 30.0].iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Number(*v));
        }
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // SUM(A:A) = 60 over the populated subset.
        assert_eq!(
            rt.set_formula(0, 0, 5, "SUM(A:A)").unwrap(),
            Value::Number(60.0)
        );
        // COUNT(A:A) = 3 numeric cells.
        assert_eq!(
            rt.set_formula(0, 1, 5, "COUNT(A:A)").unwrap(),
            Value::Number(3.0)
        );
    }

    /// **W2-literal-range — a bare `A1:A4` in SCALAR position still REJECTS.**
    /// The fix is aggregate-/reference-arg-position only; a literal range at
    /// the cell root (scalar context) must still surface the bind error so
    /// implicit-intersection-over-a-literal-range is not silently accepted.
    #[test]
    fn w2_literal_range_in_scalar_position_still_rejects() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_at(0, 1, 0, Value::Number(2.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // `=A1:A2` at the cell root is scalar context → rejects.
        let err = rt.set_formula(0, 5, 5, "A1:A2").unwrap_err();
        let msg = format!("{err:?}");
        assert!(
            msg.contains("UnsupportedVariant") && msg.contains("scalar context"),
            "expected scalar-context literal-range rejection, got: {msg}"
        );

        // `=A1:A2 + 1` — literal range as a binary operand is scalar too.
        let err2 = rt.set_formula(0, 6, 5, "A1:A2 + 1").unwrap_err();
        let msg2 = format!("{err2:?}");
        assert!(
            msg2.contains("UnsupportedVariant") && msg2.contains("scalar context"),
            "expected scalar-context rejection for a range binary operand, got: {msg2}"
        );
    }

    /// **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex MEDIUM-003
    /// / Opus MEDIUM-5):** the original
    /// `is_aggregate_function_lists_only_registered_aggregates` invariant
    /// pins only ONE direction (matcher → registry). The OPPOSITE
    /// direction (registry → matcher) was NEVER enforced, which is
    /// exactly why the W5-D-12 closure shipped a SUBTOTAL-only fix
    /// without anyone noticing that 28 other range-aware fns had the
    /// same admission gap.
    ///
    /// This invariant fills the gap: every range-aware-registered fn
    /// MUST be admitted by `is_aggregate_function`. Some range-aware
    /// fns may legitimately NOT need range args (none currently), so
    /// this is enforced as an allowlist of EXCEPTIONS — fns that are
    /// range-aware-registered but deliberately not admitted.
    ///
    /// If a future range-aware fn is registered with scalar-only args
    /// (no range args needed at all), it must be added to
    /// `range_aware_fns_that_do_not_need_aggregate_admission` below
    /// with a justification.
    #[test]
    fn every_range_aware_fn_is_admitted_to_is_aggregate_function() {
        use crate::plan::is_aggregate_function;
        let reg = default_registry();
        // Allowlist: range-aware fns that DO NOT need is_aggregate_function
        // admission because they don't accept range/named-range args.
        // **Empty as of W5-D-13.1** — every range-aware-registered fn
        // currently needs admission. If a future scalar-only RangeAwareFn
        // ships, it must be explicitly listed here with rationale.
        let exceptions: &[&str] = &[];

        let mut missing: Vec<&str> = Vec::new();
        for &name in reg.range_aware_names() {
            if exceptions.contains(&name) {
                continue;
            }
            if !is_aggregate_function(&TEST_REGISTRY, name) {
                missing.push(name);
            }
        }
        assert!(
            missing.is_empty(),
            "W5-D-13.1 invariant: every range-aware fn must be admitted to \
             is_aggregate_function (binder admission gate for named-range \
             args). Missing {} fns: {:?}. Fix: add them to the matcher in \
             plan.rs::is_aggregate_function, OR add to the exceptions \
             allowlist above with rationale.",
            missing.len(),
            missing
        );
    }

    /// Phase 2B.7 audit closure (test gaps #5 and #6): the existing NAG
    /// tests don't exercise nested aggregates with named ranges. Ensure
    /// `SUM(AVERAGE(Sales))` (both aggregate; inner is the named-range arg)
    /// and `ROUND(SUM(Sales), 2)` (outer scalar, inner aggregate with the
    /// named range) both bind cleanly to the appropriate plan shapes.
    #[test]
    fn nag_05_nested_aggregates_with_named_range_bind_cleanly() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // SUM(AVERAGE(Sales)) — outer SUM passes aggregate context to its
        // arg (the AVERAGE call), which in turn passes aggregate context
        // to its arg (the Sales NameRef). Both layers see aggregate
        // context; Sales binds to AggregateNameRef.
        // Phase 3.6 (W5-39): empty range. AVERAGE over empty = #DIV/0!
        // (per ql-functions::scalar_fns::average). Outer SUM propagates
        // the error.
        let v = rt.set_formula(0, 0, 0, "SUM(AVERAGE(Sales))").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn nag_06_round_with_nested_sum_of_named_range_binds_cleanly() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // ROUND is non-aggregate; its args bind in scalar context. The
        // FIRST arg here is SUM(Sales), which is itself a Function call —
        // recursive bind hits the SUM arm and switches to aggregate context
        // for ITS arg. Sales binds to AggregateNameRef. The outer ROUND
        // takes the SUM result + 2 in scalar context.
        // Phase 3.6 (W5-39): SUM(Sales) = 0 over empty range; ROUND(0, 2)
        // = 0.
        let v = rt.set_formula(0, 0, 0, "ROUND(SUM(Sales), 2)").unwrap();
        assert_eq!(v, Value::Number(0.0));
    }

    /// Phase 2B.7 audit (cleanup): after dropping the redundant
    /// `RecomputeResult.partial_state` pub field, `is_complete()` is the
    /// single source of truth.
    #[test]
    fn recompute_result_is_complete_is_single_source_of_truth() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_formula(0, 0, 1, "A1 + 1"); // good
        wb.put_formula(0, 0, 2, "((("); // bad

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();

        // Compile-time: no `result.partial_state` accessor exists. If a
        // future hand rolls one and exposes it as pub, this test won't
        // catch it — but the struct definition is the contract.
        assert!(!result.is_complete());
        assert_eq!(result.failed_count(), 1);
        assert_eq!(result.succeeded, 1);
        assert_eq!(result.attempted, 2);
    }

    // (Tier D1 Step 3.7: Phase 2B.5 + W5-83/90/103-107/124/125/148/149 cells tests moved.)
}
