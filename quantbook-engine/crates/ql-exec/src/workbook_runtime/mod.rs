//! `WorkbookRuntime` — the live-formula facade per Phase 1 W5-10.
//!
//! Ties the lex → parse → bind → eval → put pipeline together so callers (IDE,
//! tests, future REPL) get one method that does the right thing for a user-typed
//! formula. Plus a `recompute_all` method that re-evaluates every formula cell in
//! the workbook — used after loading a `.qbook/` directory where formula values
//! were left as `#NULL!` sentinels.
//!
//! Phase 1 W5-10 scope:
//! - `set_formula(sheet, row, col, text)` — parse + eval + persist formula text +
//!   evaluated value. Phase 3.5: routes the evaluated value to the COMPUTED
//!   overlay; clears any stale user-overlay entry at the cell first.
//! - `set_value(sheet, row, col, value)` — literal-only write; clears any existing
//!   formula association. Phase 3.5: `clear_formula` cascades to drop the
//!   computed-overlay entry too.
//! - `recompute_all()` — HashMap-order full pass. Tier C1 (2026-05-18,
//!   Phase 4.12 Opus-B H-2 closure) added an ephemeral
//!   `CalcgraphSession`-based cycle-detection pre-pass: cycled cells
//!   short-circuit to `#CIRC!` before the eval loop runs. Acyclic
//!   formulas still evaluate in HashMap order (GAP-R-01 stale-
//!   intermediate caveat unchanged).
//! - `recompute_dirty()` (Phase 3.4 W5-37) — incremental graph-driven recompute.
//!   Runs Tarjan SCC over the attached `CalcgraphSession`'s dirty set; cycled
//!   members get `Value::Error(ErrorValue::Circ)`. Phase 3.6 routes aggregates
//!   through the session's `InMemAggregateCache`; Phase 3.8 applies value-
//!   equality short-circuit; Phase 3.9 V1 tallies SIMD-eligible formulas in
//!   `RecomputeResult.simd_classified`.
//! - `validate_formula(sheet, row, col, text)` (Phase 2B.7) — full pipeline
//!   without mutation; IDE on-keystroke validation entry.
//!
//! Phase 4+ deferred (per Phase 3.10 megaudit + W5-48 Codex deep-audit):
//! - GAP-G-01 / GAP-G-03 — append-only graph rebind staleness + range-deps-
//!   not-scheduler-edges. Architectural decision needed before Phase 4.3 V2.
//! - GAP-G-02 — bulk SIMD region dispatch from graph scheduler (V1 is
//!   observability only).
//! - FN4-03 — lazy IF/IFERROR (needs scalar.rs Function-branch refactor).
//! - Cross-sheet formula references via NameTable resolution (Phase 4.6).

use ql_formula_syntax::{lex, parse};
use ql_functions::format::FormatString;
use ql_functions::FunctionRegistry;
use ql_oplog::OpLog;
use ql_storage::{FormatId, Workbook};
use ql_types::{ColId, ErrorValue, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};

use crate::env::WorkbookEnv;
#[cfg(test)]
use crate::plan::BindError;
use crate::plan::{bind_with_site, BindSite};
use crate::plan_cache::{PlanCache, PlanCacheStats};
use crate::transaction::WorkbookTransaction;

// **Tier D1 (2026-05-18 — Phase 5 prep, monolith split):** sibling
// submodules under `crate::workbook_runtime`. Each submodule adds an
// `impl<'a> WorkbookRuntime<'a> { ... }` block to extend the struct
// without changing its public API surface. See
// `docs/architecture/workbook-runtime-split-design.md`.
//
// Step 1 (2026-05-18, commit 79c1ebeefa7): error/result types →
//   `error.rs`. Re-exported here so callers continue to import
//   `RuntimeError` / `RecomputeFailure` / `RecomputeResult` from
//   `crate::workbook_runtime` unchanged.
// Step 3.1 (2026-05-18): format API (intern_format, set_cell_format,
//   read_display) → `formats.rs`. No public re-export needed (methods
//   stay on `WorkbookRuntime`).
// Step 3.2 (2026-05-18): workbook config setters (set_reference_mode,
//   set_locale) → `config.rs`. As a side effect, the rename_table doc
//   that was previously misattached to set_reference_mode now correctly
//   attaches to pub fn rename_table.
// Step 3.3 (2026-05-18): sheet API (add_sheet, rename_sheet) + the
//   private `rewrite_formula_text_for_sheet_rename` helper → `sheets.rs`.
// Step 3.4 (2026-05-18): defined-name API (set_name,
//   set_sheet_scoped_name) → `names.rs`. Folded-in cleanup: 3
//   misplaced add_sheet W5-93 tests that should have moved with
//   Step 3.3 now live in sheets.rs::tests.
// Step 3.5 (2026-05-18): table mutation API (create_table, drop_table,
//   rename_table, rename_column, resize_table, reextract_table_readers
//   private helper) → `tables.rs`. Biggest single step: ~819 LOC impl
//   + ~1,380 LOC tests (W5-116/118/119/121/122 clusters).
// Step 3.6 (2026-05-18): recompute pipeline (recompute_all,
//   recompute_dirty, try_recompute_one_cached,
//   try_recompute_with_aggregate_cache, try_recompute_with_simd_profile)
//   → `recompute.rs`. Test clusters: recompute_all, Tier C1, 2B.2, 2B.3,
//   2B.4, Phase 3.1 calcgraph integration.
// Step 3.7 (2026-05-18): cell mutation API (set_formula, set_value,
//   clear_formula, write_spill, write_anchor_error,
//   reextract_spill_footprint_readers) → `cells.rs`. Largest method-
//   LOC step: set_formula alone is 417 LOC. Test clusters: set_formula
//   + set_value + Phase 2A.3.b + Phase 2B.5 + W5-83/90/103-107/124/
//   125/148/149.
mod cells;
mod config;
mod error;
mod formats;
mod names;
mod recompute;
mod sheets;
mod tables;
pub use error::{RecomputeFailure, RecomputeResult, RuntimeError};

/// Phase 2A.6 audit H1/L4 (2026-05-12) helper. Confirms `sheet` is in range
/// before any work that would otherwise panic inside `Workbook::put_at`.
/// `pub(crate)` so `WorkbookTransaction` can call the same validator at
/// `put_value` / `put_formula` buffering time.
pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
    let count = workbook.sheet_count();
    if (sheet as usize) >= count {
        return Err(RuntimeError::InvalidSheet {
            sheet,
            sheet_count: count,
        });
    }
    Ok(())
}

/// Phase 2A.7 audit H1 (2026-05-12) helper. Combines sheet validation with
/// row/col bounds checks so the runtime entry points refuse out-of-grid
/// coordinates before any work that would otherwise panic inside
/// `Sheet::put` (which asserts `row <= MAX_ROW && col <= MAX_COLUMN`). The
/// Phase 2A.6 audit closed sheet-id panics but missed row/col — three
/// independent megaudit agents flagged the gap. `pub(crate)` so
/// `WorkbookTransaction` can call the same validator at buffer time.
///
/// **Tier D1 Step 3.3 doc-attachment fix:** this doc block was
/// previously misattached to a `rewrite_formula_text_for_sheet_rename`
/// helper that lived between this comment and `validate_cell`. The
/// helper moved to `sheets.rs` along with `rename_sheet`, so the doc
/// now reaches its intended target.
pub(crate) fn validate_cell(
    workbook: &Workbook,
    sheet: SheetId,
    row: RowId,
    col: ColId,
) -> Result<(), RuntimeError> {
    validate_sheet(workbook, sheet)?;
    if row > MAX_ROW {
        return Err(RuntimeError::InvalidCell {
            sheet,
            row,
            col,
            why: "row exceeds MAX_ROW (1,048,575)",
        });
    }
    if col > MAX_COLUMN {
        return Err(RuntimeError::InvalidCell {
            sheet,
            row,
            col,
            why: "col exceeds MAX_COLUMN (16,383)",
        });
    }
    Ok(())
}

// (Tier D1 Step 1: error/result types moved to error.rs above —
//  see the mod declaration + pub use at the top of this file.)

/// Live-formula facade. Wraps a `&mut Workbook` + `&FunctionRegistry`.
///
/// Construct one per session of cell edits. Re-creating per call is cheap (the
/// struct holds borrows, no heap state of its own).
///
/// Phase 2A.3.b (2026-05-12): optionally attach an `OpLog` via
/// `WorkbookRuntime::with_oplog`. When attached, `set_value` and `set_formula`
/// emit ops into the log in append-before-mutate order. `transaction()`
/// re-borrows the op-log handle into the returned transaction so a single op
/// log records both individual edits and batched commits cohesively.
pub struct WorkbookRuntime<'a> {
    workbook: &'a mut Workbook,
    registry: &'a FunctionRegistry,
    /// Optional op-log sink. When `Some`, all producer methods append before
    /// mutating the workbook so a failing append leaves the workbook
    /// unchanged. When `None`, the runtime behaves exactly as Phase 1 W5-10.
    oplog: Option<&'a mut OpLog>,
    /// Phase 2B.3 bind-plan cache. Lives for the runtime's lifetime;
    /// successive `set_formula` and `recompute_all` calls hit the cache
    /// for unchanged formula text under the same NameTable generation.
    /// See `crate::plan_cache` module docs for the invalidation contract.
    plan_cache: PlanCache,
    /// Phase 3.1 (2026-05-12) optional calcgraph session. When `Some`,
    /// every mutation method calls the corresponding hook on the
    /// session AFTER the workbook mutation succeeds. Phase 3.1 hooks
    /// are stubs (counter bumps + cell-index updates); Phase 3.3 wires
    /// dirty propagation through the same surface. See
    /// `crate::calcgraph_session` module docs for the ownership model.
    graph: Option<&'a mut crate::CalcgraphSession>,
    /// **W5-82 (Phase 4.5.D part 6):** parsed `FormatString` cache keyed
    /// by `FormatId`. `read_display` populates on-demand from
    /// `Workbook::formats()` lookup; `FormatTable::register_at` rejects
    /// id→string mutations, so cache entries stay stable for the
    /// runtime's lifetime. A new `RegisterFormat` op merely inserts a
    /// new entry; no invalidation needed.
    format_cache: std::collections::HashMap<FormatId, FormatString>,
}

impl<'a> WorkbookRuntime<'a> {
    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
        Self {
            workbook,
            registry,
            oplog: None,
            plan_cache: PlanCache::new(),
            format_cache: std::collections::HashMap::new(),
            graph: None,
        }
    }

    /// Phase 2A.3.b: construct a runtime that records every mutation to the
    /// supplied `OpLog`. Producer-replay equivalence: replaying the resulting
    /// log against a fresh workbook (then calling `recompute_all` to
    /// materialize formula values) reproduces the same observable state.
    ///
    /// See module docs for the documented limitations: `set_value(Value::Blank)`
    /// emits no `PutValue` (CellWireValue lacks a Blank variant in 2A.3.b);
    /// NaN/Inf in number values fail serde_json serialization and surface as
    /// `RuntimeError::OpLog`.
    pub fn with_oplog(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        oplog: &'a mut OpLog,
    ) -> Self {
        Self {
            workbook,
            registry,
            oplog: Some(oplog),
            plan_cache: PlanCache::new(),
            format_cache: std::collections::HashMap::new(),
            graph: None,
        }
    }

    /// Phase 3.1 (2026-05-12): construct a runtime that fires calcgraph
    /// mutation hooks on every producer method. Phase 3.1 hooks are
    /// stubs (counter bumps + cell-index updates) — they accumulate
    /// state that Phase 3.3 will turn into real dirty propagation and
    /// edge updates. Today's recompute_all still walks formulas in
    /// HashMap order; Phase 3.4 replaces it with a Tarjan-SCC-scheduled
    /// graph walk.
    pub fn with_graph(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        graph: &'a mut crate::CalcgraphSession,
    ) -> Self {
        Self {
            workbook,
            registry,
            oplog: None,
            plan_cache: PlanCache::new(),
            format_cache: std::collections::HashMap::new(),
            graph: Some(graph),
        }
    }

    /// Phase 3.1 (2026-05-12): construct a runtime with BOTH an attached
    /// op log and an attached calcgraph session. The combined-attachment
    /// constructor mirrors the IDE pattern (open file → load oplog +
    /// rebuild graph → hand both to the runtime per edit). Order of
    /// operations per mutation: lex+parse+bind → op-log append → workbook
    /// mutation → graph hook.
    pub fn with_oplog_and_graph(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        oplog: &'a mut OpLog,
        graph: &'a mut crate::CalcgraphSession,
    ) -> Self {
        Self {
            workbook,
            registry,
            oplog: Some(oplog),
            plan_cache: PlanCache::new(),
            format_cache: std::collections::HashMap::new(),
            graph: Some(graph),
        }
    }

    /// Phase 2B.3: snapshot of cumulative bind-plan-cache observability
    /// since this runtime was constructed. Includes hit count, miss
    /// count, entry count, and convenience hit-rate.
    pub fn cache_stats(&self) -> PlanCacheStats {
        self.plan_cache.stats()
    }

    // (Tier D1 Step 3.7: 6 cell methods + spill helpers moved
    //  to cells.rs sibling submodule.)

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
        )
    }

    /// Re-evaluate every formula in the workbook. Used after `load_workbook` to
    /// refresh stale values (the qbook loader stores formula text + a sentinel
    /// value; this method computes the real value).
    ///
    /// Iteration order is HashMap-arbitrary, so cross-cell dependencies may
    /// evaluate in a non-deterministic order. Engine Phase 3 calcgraph
    /// integration will add topological scheduling for deterministic + correct
    /// dependency resolution (see `docs/MASTER-PLAN.md` Phase 3.4; tracked as
    /// GAP-R-01 in `docs/known-gaps.md`).
    ///
    /// Phase 2B.2 (2026-05-12): signature changed from `Result<usize,
    /// RuntimeError>` to `RecomputeResult` (always returns; no Result
    /// wrapper). The prior shape short-circuited on first failure and
    /// dropped per-cell context; the new shape continues past failures
    /// and aggregates them. See [`RecomputeResult`] for the contract.
    ///
    /// Cells that fail structurally (lex/parse/bind) keep their
    /// pre-recompute values and formula text. Cells that succeed have
    /// their value replaced. Cells whose evaluation produces an Excel-
    /// canon error value (`#DIV/0!`, `#VALUE!`, etc.) are counted as
    /// succeeded — those error values are normal cell contents per
    /// Excel canon, not structural failures.
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

    // (Tier D1 Step 3.6: 5 recompute methods moved to
    //  recompute.rs sibling submodule.)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_functions::default_registry;
    use ql_types::ErrorValue;

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // (Tier D1 Step 3.7: set_formula + set_value tests moved.)

    // ===== Phase 2A.1 — named-range resolution =====

    #[test]
    fn set_formula_resolves_named_cell_target() {
        use ql_storage::NamedTarget;
        use ql_types::Address;

        let mut wb = make_runtime_workbook();
        // A1 = 42; register MYREF → $A$1.
        wb.put_at(0, 0, 0, Value::Number(42.0));
        wb.set_name("MyRef", NamedTarget::Cell(Address::new(0, 0, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // =MyRef + 1 → 43. The bare ident parses as NameRef, the binder resolves
        // it to a CellRef via the workbook's name table.
        let v = rt.set_formula(0, 1, 0, "MyRef + 1").unwrap();
        assert_eq!(v, Value::Number(43.0));
    }

    #[test]
    fn set_formula_resolves_named_number_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        // TaxRate = 0.21 as a named constant.
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "100 * TaxRate").unwrap();
        assert_eq!(v, Value::Number(21.0));
    }

    #[test]
    fn set_formula_resolves_named_boolean_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        wb.set_name("UseFancy", NamedTarget::Constant(Value::Boolean(true)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Phase 0 binder accepts Boolean as ExprPlan::Bool literal. Evaluating
        // a bare NameRef should return the boolean.
        let v = rt.set_formula(0, 0, 0, "UseFancy").unwrap();
        assert_eq!(v, Value::Boolean(true));
    }

    #[test]
    fn set_formula_resolves_named_text_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        wb.set_name("Greeting", NamedTarget::Constant(Value::text("hello")))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "Greeting").unwrap();
        assert_eq!(v, Value::text("hello"));
    }

    #[test]
    fn set_formula_unresolved_name_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // No name registered → bind-time UnresolvedName, surfaced as RuntimeError::Bind.
        let result = rt.set_formula(0, 0, 0, "UnknownName + 1");
        match result {
            Err(RuntimeError::Bind(BindError::UnresolvedName(name))) => {
                assert_eq!(name.as_ref(), "UNKNOWNNAME");
            }
            other => panic!("expected Bind(UnresolvedName), got {other:?}"),
        }
        // No partial write on bind failure.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Blank);
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// Phase 2A.11 audit M16: error Display strings are human-readable, not
    /// Rust-debug syntax. Previously `RuntimeError::Bind(BindError::Unresolved
    /// Name("X"))` rendered via `{0:?}` and surfaced "bind error:
    /// UnresolvedName(\"X\")" — Rust debug format with an awkward bracket+
    /// quote spelling. Now reads "bind error: unresolved name \"X\"".
    #[test]
    fn runtime_error_bind_display_is_human_readable() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .set_formula(0, 0, 0, "UnknownName + 1")
            .expect_err("expected an error");
        let display = err.to_string();
        // The display contains the user-facing canonical name; no Rust
        // debug-syntax markers like `UnresolvedName(...)`.
        assert!(
            display.contains("UNKNOWNNAME"),
            "Display lost the name: {display:?}"
        );
        assert!(
            !display.contains("UnresolvedName"),
            "Display still leaks Rust variant syntax: {display:?}"
        );
    }

    #[test]
    fn runtime_error_lex_display_is_human_readable() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // **W5-143 (Phase 4.9.G):** `@` is now the implicit-intersection
        // operator, so it's no longer a lex error. Use backtick (`)
        // which has no Excel-formula lexical role and stays
        // unrepresentable.
        let err = rt
            .set_formula(0, 0, 0, "`foo")
            .expect_err("expected an error");
        let display = err.to_string();
        assert!(
            display.contains("unexpected character"),
            "Display lost the message: {display:?}"
        );
        // No debug-syntax leak like `UnexpectedChar('`')`.
        assert!(
            !display.contains("UnexpectedChar"),
            "Display still leaks Rust variant syntax: {display:?}"
        );
    }

    /// Phase 2B.4 (2026-05-12): named range in a bare scalar position now
    /// surfaces the precise `NamedRangeInScalarContext` instead of the
    /// generic `UnsupportedVariant`. Aggregate-context usage (e.g.
    /// `=SUM(Sales)`) is now accepted and binds to `ExprPlan::AggregateNameRef`.
    /// NAG-04 acceptance.
    #[test]
    fn set_formula_named_range_in_scalar_context_errors() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_formula(0, 0, 0, "Sales");
        match result {
            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(name))) => {
                // Parser canonicalizes to upper case.
                assert_eq!(name.as_ref(), "SALES");
            }
            other => panic!("expected Bind(NamedRangeInScalarContext), got {other:?}"),
        }
    }

    #[test]
    fn recompute_all_resolves_named_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        // Seed a formula manually (skipping set_formula) so recompute_all does the work.
        wb.put_at(0, 0, 0, Value::Number(0.0));
        wb.put_formula(0, 0, 0, "1000 * TaxRate");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.succeeded, 1);
        assert!(result.is_complete());
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Number(210.0)
        );
    }

    #[test]
    fn set_name_uppercases_for_canonical_lookup() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        // Register with mixed case — the parser will uppercase NameRef tokens, so
        // lookup must succeed regardless of how the source wrote the name.
        wb.set_name("MixedCaseName", NamedTarget::Constant(Value::Number(5.0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Lowercased reference still resolves.
        let v = rt.set_formula(0, 0, 0, "mixedcasename + 1").unwrap();
        assert_eq!(v, Value::Number(6.0));
    }

    // (Tier D1 Step 3.7: Phase 2A.3.b op-log producer tests moved.)

    // ===== Phase 2B.7 — audit closure: input validation + dry-run + cleanup =====

    /// Phase 2B.7 audit H1: `add_sheet` rejects `chunk_rows == 0` BEFORE
    /// any op-log append. Without this check, the workbook gets a sheet
    /// with `chunk_rows = 0` and the first cell write panics inside the
    /// column store — and the op log has a phantom AddSheet entry that
    /// would replay the same poison state on next load.
    #[test]
    fn add_sheet_rejects_zero_chunk_rows() {
        use ql_oplog::OpLog;
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let result = {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.add_sheet("Bad", 0)
        };
        match result {
            Err(RuntimeError::InvalidChunkRows(0)) => {}
            other => panic!("expected InvalidChunkRows(0), got {other:?}"),
        }
        // No sheet added; no op-log entry.
        assert_eq!(wb.sheet_count(), 0);
        assert!(
            oplog.is_empty(),
            "op log must stay empty on validation failure"
        );
    }

    /// Phase 2B.7 audit (correctness L4): `clear_formula` propagates
    /// `RuntimeError::InvalidSheet` / `InvalidCell` from `validate_cell`.
    #[test]
    fn clear_formula_rejects_invalid_sheet() {
        let mut wb = make_runtime_workbook(); // 1 sheet
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.clear_formula(99, 0, 0);
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidSheet {
                    sheet: 99,
                    sheet_count: 1
                })
            ),
            "expected InvalidSheet, got {result:?}"
        );
    }

    #[test]
    fn clear_formula_rejects_invalid_cell() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.clear_formula(0, 1_048_576, 0);
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidCell { row: 1_048_576, .. })
            ),
            "expected InvalidCell, got {result:?}"
        );
    }

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
            if !is_aggregate_function(name) {
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
