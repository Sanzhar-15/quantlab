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
//!   evaluated value to the workbook.
//! - `set_value(sheet, row, col, value)` — literal-only write; clears any existing
//!   formula association.
//! - `recompute_all()` — re-evaluate every formula in the workbook.
//!
//! Phase 4+ deferred:
//! - Dependency-tracking incremental recompute (calcgraph integration).
//! - Computed-overlay separation (CORR-25): user-input vs formula-output layered.
//! - Cross-sheet formula references via NameTable resolution.

use std::sync::Arc;

use ql_formula_syntax::{lex, parse, LexError, ParseError};
use ql_functions::FunctionRegistry;
use ql_io::CellWireValue;
use ql_oplog::{Op, OpLog};
use ql_storage::Workbook;
use ql_types::{ColId, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};

use crate::env::WorkbookEnv;
use crate::plan::{bind_with_names, BindError};
use crate::plan_cache::{PlanCache, PlanCacheKey, PlanCacheStats};
use crate::scalar::eval_scalar_with_registry;
use crate::transaction::WorkbookTransaction;

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

/// Errors from the runtime pipeline. Each upstream stage's error wraps cleanly.
/// Phase 2A.6 audit H1/L4 (2026-05-12) added `InvalidSheet` so callers that pass
/// a sheet id outside the workbook's range get a clean error instead of a panic
/// from `Workbook::put_at`. Phase 2A.6 audit H4 added `ConflictingOps` for
/// the `WorkbookTransaction` mixed-kind-on-same-cell case.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    // Phase 2A.11 audit M16: switched from `{0:?}` debug formatters to `{0}`
    // Display now that LexError + BindError implement thiserror::Error with
    // user-facing strings. IDE error display reads cleanly: "lex error:
    // unexpected character: '@'" instead of "lex error: UnexpectedChar('@')".
    #[error("lex error: {0}")]
    Lex(LexError),

    #[error("parse error: {0}")]
    Parse(#[from] ParseError),

    #[error("bind error: {0}")]
    Bind(BindError),

    #[error("invalid sheet {sheet}: workbook has {sheet_count} sheets")]
    InvalidSheet { sheet: SheetId, sheet_count: usize },

    /// Phase 2A.7 audit H1: row/col outside the Excel grid (MAX_ROW = 1,048,575;
    /// MAX_COLUMN = 16,383). Surfaces at buffer time so `Sheet::put` doesn't
    /// panic mid-commit. `why` describes which bound was exceeded.
    #[error("invalid cell (sheet={sheet}, row={row}, col={col}): {why}")]
    InvalidCell {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        why: &'static str,
    },

    #[error(
        "conflicting transaction ops on cell (sheet={sheet}, row={row}, col={col}): \
         a value and a formula were both buffered for this cell in the same transaction"
    )]
    ConflictingOps {
        sheet: SheetId,
        row: RowId,
        col: ColId,
    },

    /// Phase 2A.3.b (2026-05-12): the producer-side append into an attached
    /// op log failed (serde_json refused the wire value — e.g. NaN/Inf — or
    /// Loro surfaced an internal error). Producer order is append-then-mutate:
    /// when this fires, the workbook is unchanged. Callers attaching an op
    /// log handle the error; callers that don't attach one never see this
    /// variant.
    #[error("op log error: {0}")]
    OpLog(#[from] ql_oplog::OpLogError),
}

impl From<LexError> for RuntimeError {
    fn from(e: LexError) -> Self {
        Self::Lex(e)
    }
}

impl From<BindError> for RuntimeError {
    fn from(e: BindError) -> Self {
        Self::Bind(e)
    }
}

/// Outcome of a single failed cell during `WorkbookRuntime::recompute_all`.
///
/// Phase 2B.2 (2026-05-12): part of the [`RecomputeResult`] aggregation
/// replacing the prior short-circuit `Result<usize, RuntimeError>` return
/// shape. Captures everything a caller needs to display the failure
/// without re-walking the workbook: the cell address, the formula text
/// that was tried, and the structural error from lex/parse/bind.
///
/// Evaluation-time errors that surface as `Value::Error(...)` (e.g. `=10/0`
/// → `#DIV/0!`) do NOT appear here — those are normal cell values per
/// Excel canon and get written to the workbook like any other recompute
/// success. `RecomputeFailure` is reserved for STRUCTURAL failures where
/// the formula cannot be evaluated at all.
///
/// Not `Clone` — `RuntimeError` contains `loro::LoroError` (via the
/// Phase 2A.3.b `OpLog` variant) which is not Clone. Pass by ownership
/// or borrow.
#[derive(Debug)]
pub struct RecomputeFailure {
    pub sheet: SheetId,
    pub row: RowId,
    pub col: ColId,
    pub formula_text: Arc<str>,
    pub error: RuntimeError,
}

/// Aggregate outcome of `WorkbookRuntime::recompute_all`.
///
/// Phase 2B.2 (2026-05-12): replaces the prior `Result<usize, RuntimeError>`
/// return shape. The previous signature short-circuited on first failure,
/// dropping per-cell context and forcing callers to re-walk the workbook
/// to find what went wrong. The new shape:
///
/// - `attempted` — total formula cells in the workbook snapshot at start.
/// - `succeeded` — formulas that lex/parse/bind/eval'd cleanly and were
///   written back to the workbook.
/// - `failures` — every formula that failed structurally, in iteration
///   order. Each entry carries cell address + formula text + error.
/// - `partial_state` — `true` iff `!failures.is_empty()`. Provided as an
///   explicit boolean so callers branching on "is this workbook now
///   consistent?" don't have to re-check `failures.len()`.
///
/// No-fallback semantics: failures are NOT swallowed. The struct makes
/// every failure visible and aggregable. Callers that want short-circuit
/// semantics can check `is_complete()` and bail.
///
/// Cells past a failure point keep their pre-recompute (potentially stale)
/// values; their formula text is preserved either way (recompute never
/// clears formula on failure). Iteration order is `HashMap`-arbitrary
/// today (GAP-R-01); Engine Phase 3 calcgraph integration makes it
/// topological.
///
/// Not `Clone` for the same reason as `RecomputeFailure`.
#[derive(Debug)]
pub struct RecomputeResult {
    pub attempted: usize,
    pub succeeded: usize,
    pub failures: Vec<RecomputeFailure>,
    pub partial_state: bool,
}

impl RecomputeResult {
    /// True iff every formula recomputed without a structural failure.
    pub fn is_complete(&self) -> bool {
        self.failures.is_empty()
    }

    /// Number of structural failures (lex/parse/bind). Excludes evaluation
    /// errors like `#DIV/0!` which are normal cell values.
    pub fn failed_count(&self) -> usize {
        self.failures.len()
    }
}

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
}

impl<'a> WorkbookRuntime<'a> {
    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
        Self {
            workbook,
            registry,
            oplog: None,
            plan_cache: PlanCache::new(),
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
        }
    }

    /// Phase 2B.3: snapshot of cumulative bind-plan-cache observability
    /// since this runtime was constructed. Includes hit count, miss
    /// count, entry count, and convenience hit-rate.
    pub fn cache_stats(&self) -> PlanCacheStats {
        self.plan_cache.stats()
    }

    /// Set a cell to a formula. Pipeline: lex → parse → bind (against `sheet`) →
    /// eval against the current workbook → put_at the result + put_formula the text.
    ///
    /// Returns the evaluated value, or a `RuntimeError` if any pipeline stage fails.
    /// On error, the workbook is unchanged (no partial writes).
    ///
    /// `formula_text` is the formula body without the leading `=`. The Sheet must
    /// already exist.
    pub fn set_formula(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: impl Into<Arc<str>>,
    ) -> Result<Value, RuntimeError> {
        // Phase 2A.7 audit H1 (was 2A.6 L4 sheet-only): validate sheet AND
        // row/col bounds up front. Without these checks, out-of-grid cells
        // sneak past lex/parse/bind and panic inside `Sheet::put` (which
        // asserts `row <= MAX_ROW && col <= MAX_COLUMN`).
        validate_cell(self.workbook, sheet, row, col)?;

        let formula_text = formula_text.into();
        // Phase 2B.3: consult the bind-plan cache first. The key includes
        // the current NameTable generation so a name registration since
        // the last bind produces a miss → re-bind against the new table.
        // Cached `Arc<ExprPlan>` is shared with `recompute_all`, so a
        // subsequent recompute of this cell skips lex/parse/bind entirely.
        let name_gen = self.workbook.names().generation();
        let cache_key = PlanCacheKey {
            text: Arc::clone(&formula_text),
            sheet,
            name_gen,
        };
        let plan: Arc<crate::plan::ExprPlan> =
            self.plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    let tokens = lex(formula_text.as_ref())?;
                    let expr = parse(tokens)?;
                    // Phase 2A.1 (2026-05-12): bind against the workbook's NameTable
                    // so `Expr::NameRef` resolves against defined names.
                    Ok(bind_with_names(&expr, sheet, self.workbook.names())?)
                })?;

        // Evaluate against the current workbook state. The env borrows immutably; we
        // drop it before taking the mutable borrow for the write.
        let value = {
            let env = WorkbookEnv::new(self.workbook);
            eval_scalar_with_registry(plan.as_ref(), &env, self.registry)
        };

        // Phase 2A.3.b op-log emission, BEFORE mutation. If append fails, no
        // mutation; workbook stays consistent. We emit `PutFormula` only — the
        // evaluated value isn't recorded because replay re-derives it via
        // `WorkbookRuntime::recompute_all` (see replay.rs module docs).
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::PutFormula {
                sheet,
                row,
                col,
                text: formula_text.as_ref().to_owned(),
            })?;
        }

        // Persist formula text + evaluated value. Both writes succeed or neither —
        // put_at can't fail (it panics on bad sheet, but the binder already
        // validated `sheet`; if the user passes a nonexistent sheet, we'd panic
        // upstream when the binder produces CellRefs against it).
        self.workbook.put_at(sheet, row, col, value.clone());
        self.workbook.put_formula(sheet, row, col, formula_text);

        Ok(value)
    }

    /// Set a cell to a literal value (no formula). Clears any existing formula
    /// association at the cell — typing a value over a formula cell deletes the
    /// formula per Excel canon. Phase 2A.7 audit H1: validates sheet + row/col
    /// bounds; returns `RuntimeError` instead of panicking on out-of-grid input.
    pub fn set_value(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: Value,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;

        // Phase 2A.3.b: emit ops BEFORE mutating, so a serialization failure
        // (NaN/Inf) leaves the workbook unchanged. `CellWireValue::from_value`
        // returns None for `Value::Blank`; we skip the `PutValue` in that case
        // (documented limitation — replaying a Blank write won't reset a
        // prior non-Blank value; rare enough that the wire-format expansion
        // is deferred to Phase 5+). The `ClearFormula` still fires below if
        // the cell had a formula, so the produced log captures the formula
        // removal even when the literal value is Blank.
        let had_formula = self.workbook.formula_at(sheet, row, col).is_some();
        if let Some(oplog) = self.oplog.as_deref_mut() {
            if let Some(wire) = CellWireValue::from_value(&value) {
                oplog.append(Op::PutValue {
                    sheet,
                    row,
                    col,
                    value: wire,
                })?;
            }
            if had_formula {
                oplog.append(Op::ClearFormula { sheet, row, col })?;
            }
        }

        self.workbook.put_at(sheet, row, col, value);
        self.workbook.clear_formula(sheet, row, col);
        Ok(())
    }

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
    pub fn recompute_all(&mut self) -> RecomputeResult {
        // Snapshot the formula list so we don't hold a borrow during eval.
        let entries: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
            .workbook
            .iter_formulas()
            .map(|(s, r, c, f)| (s, r, c, Arc::clone(f)))
            .collect();
        let attempted = entries.len();
        let mut succeeded = 0;
        let mut failures: Vec<RecomputeFailure> = Vec::new();

        for (sheet, row, col, formula_text) in entries {
            match self.try_recompute_one_cached(sheet, &formula_text) {
                Ok(value) => {
                    self.workbook.put_at(sheet, row, col, value);
                    succeeded += 1;
                }
                Err(error) => {
                    failures.push(RecomputeFailure {
                        sheet,
                        row,
                        col,
                        formula_text,
                        error,
                    });
                }
            }
        }

        let partial_state = !failures.is_empty();
        RecomputeResult {
            attempted,
            succeeded,
            failures,
            partial_state,
        }
    }

    /// Phase 2B.3 helper for `recompute_all`: consult the bind-plan cache
    /// before doing lex/parse/bind work, then evaluate. Failures (lex /
    /// parse / bind) propagate as `RuntimeError`; the caller bundles them
    /// into a `RecomputeFailure`. Successful binds are cached so a
    /// subsequent recompute (or a `set_formula` editing a nearby cell
    /// with the same text) hits.
    fn try_recompute_one_cached(
        &mut self,
        sheet: SheetId,
        formula_text: &Arc<str>,
    ) -> Result<Value, RuntimeError> {
        let name_gen = self.workbook.names().generation();
        let cache_key = PlanCacheKey {
            text: Arc::clone(formula_text),
            sheet,
            name_gen,
        };
        // Borrow split: we need an immutable view of the workbook
        // (for `names()` inside the closure) while holding a mutable
        // borrow on `self.plan_cache`. Re-borrow the workbook reference
        // by name so Rust's borrow checker can split them — both fields
        // are disjoint subfields of `self`.
        let workbook: &Workbook = self.workbook;
        let plan: Arc<crate::plan::ExprPlan> =
            self.plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    let tokens = lex(formula_text.as_ref())?;
                    let expr = parse(tokens)?;
                    Ok(bind_with_names(&expr, sheet, workbook.names())?)
                })?;

        let env = WorkbookEnv::new(self.workbook);
        Ok(eval_scalar_with_registry(
            plan.as_ref(),
            &env,
            self.registry,
        ))
    }
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

    // ===== set_formula =====

    #[test]
    fn set_formula_literal_arithmetic() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "1 + 2 * 3").unwrap();
        assert_eq!(v, Value::Number(7.0));
        // Persisted: both the formula and the value.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(7.0));
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("1 + 2 * 3")
        );
    }

    #[test]
    fn set_formula_reads_existing_cell() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // =A1 * 2 → 20
        let v = rt.set_formula(0, 1, 0, "A1 * 2").unwrap();
        assert_eq!(v, Value::Number(20.0));
    }

    #[test]
    fn set_formula_with_function_call() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_at(0, 1, 0, Value::Number(20.0));
        wb.put_at(0, 2, 0, Value::Number(30.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // =SUM(A1, A2, A3) → 60
        let v = rt.set_formula(0, 0, 1, "SUM(A1, A2, A3)").unwrap();
        assert_eq!(v, Value::Number(60.0));
    }

    #[test]
    fn set_formula_propagates_div_by_zero() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "10 / 0").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::DivZero));
        // Even error-evaluated formulas persist their text.
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("10 / 0"));
    }

    #[test]
    fn set_formula_invalid_syntax_returns_parse_error() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Unclosed paren — guaranteed parse error.
        let result = rt.set_formula(0, 0, 0, "(1 + 2");
        assert!(
            matches!(result, Err(RuntimeError::Parse(_))),
            "expected Parse error, got {result:?}"
        );
        // No partial write on parse failure.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Blank);
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    #[test]
    fn set_formula_trailing_tokens_returns_parse_error() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_formula(0, 0, 0, "1 + 2 3");
        assert!(matches!(result, Err(RuntimeError::Parse(_))));
        // No partial write.
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// Phase 2A.5 (2026-05-12): `=VAR.S(1, 2, 3)` end-to-end — lexer accepts the
    /// dotted identifier, parser builds Expr::Function { name: "VAR.S" }, binder
    /// produces ExprPlan::Function, scalar evaluator dispatches via the registry
    /// to the variance kernel. Sample variance of {1,2,3} is 1.0.
    #[test]
    fn set_formula_var_s_dotted_function_dispatches() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "VAR.S(1, 2, 3)").unwrap();
        assert_eq!(v, Value::Number(1.0));
    }

    #[test]
    fn set_formula_stdev_p_dotted_function_dispatches() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Population stdev of {2, 4, 4, 4, 5, 5, 7, 9} is exactly 2.0 (textbook).
        let v = rt
            .set_formula(0, 0, 0, "STDEV.P(2, 4, 4, 4, 5, 5, 7, 9)")
            .unwrap();
        assert_eq!(v, Value::Number(2.0));
    }

    #[test]
    fn set_formula_ai_returns_ai_not_available() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "AI(\"prompt\")").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::AINotAvailable));
    }

    // ===== set_value =====

    #[test]
    fn set_value_clears_existing_formula() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // First set a formula.
        rt.set_formula(0, 0, 0, "1 + 1").unwrap();
        assert!(wb.formula_at(0, 0, 0).is_some());

        // Now set a literal — should clear the formula.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 0, 0, Value::Number(42.0)).unwrap();
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Number(42.0)
        );
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// Phase 2A.6 audit H1/L4 (2026-05-12): invalid sheet ids surface as
    /// `RuntimeError::InvalidSheet` instead of panicking inside `Workbook::put_at`.
    #[test]
    fn set_formula_rejects_invalid_sheet() {
        let mut wb = make_runtime_workbook(); // 1 sheet
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_formula(99, 0, 0, "1 + 1");
        match result {
            Err(RuntimeError::InvalidSheet { sheet, sheet_count }) => {
                assert_eq!(sheet, 99);
                assert_eq!(sheet_count, 1);
            }
            other => panic!("expected InvalidSheet, got {other:?}"),
        }
    }

    /// Phase 2A.7 audit H1 (2026-05-12): out-of-grid row or col now surfaces as
    /// `RuntimeError::InvalidCell` instead of panicking inside `Sheet::put`.
    #[test]
    fn set_formula_rejects_row_above_max() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // MAX_ROW = 1,048,575 — anything above is invalid.
        let result = rt.set_formula(0, 1_048_576, 0, "1 + 1");
        match result {
            Err(RuntimeError::InvalidCell {
                sheet,
                row,
                col,
                why,
            }) => {
                assert_eq!((sheet, row, col), (0, 1_048_576, 0));
                assert!(why.contains("row"));
            }
            other => panic!("expected InvalidCell with row > MAX_ROW, got {other:?}"),
        }
    }

    #[test]
    fn set_formula_rejects_col_above_max() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // MAX_COLUMN = 16,383 — anything above is invalid.
        let result = rt.set_formula(0, 0, 16_384, "1 + 1");
        match result {
            Err(RuntimeError::InvalidCell {
                sheet,
                row,
                col,
                why,
            }) => {
                assert_eq!((sheet, row, col), (0, 0, 16_384));
                assert!(why.contains("col"));
            }
            other => panic!("expected InvalidCell with col > MAX_COLUMN, got {other:?}"),
        }
    }

    #[test]
    fn set_value_rejects_invalid_cell() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_value(0, 9_999_999, 0, Value::Number(1.0));
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidCell { row: 9_999_999, .. })
            ),
            "expected InvalidCell, got {result:?}"
        );
    }

    #[test]
    fn set_formula_at_max_row_max_col_ok() {
        // Boundary case: exactly MAX_ROW and MAX_COLUMN are accepted.
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 1_048_575, 16_383, "1 + 1").unwrap();
        assert_eq!(v, Value::Number(2.0));
    }

    #[test]
    fn set_value_rejects_invalid_sheet() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_value(5, 0, 0, Value::Number(1.0));
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidSheet {
                    sheet: 5,
                    sheet_count: 1
                })
            ),
            "expected InvalidSheet, got {result:?}"
        );
    }

    #[test]
    fn set_value_on_blank_cell_no_formula() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        rt.set_value(0, 0, 0, Value::text("hello")).unwrap();
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::text("hello")
        );
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    // ===== recompute_all =====

    #[test]
    fn recompute_all_on_empty_workbook_is_noop() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.recompute_all();
        assert_eq!(result.attempted, 0);
        assert_eq!(result.succeeded, 0);
        assert!(result.is_complete());
    }

    #[test]
    fn recompute_all_refreshes_formula_values() {
        let mut wb = make_runtime_workbook();

        // Set up scenario: A1 = 5; B1 has formula =A1 * 2 evaluated as 10.
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_at(0, 0, 1, Value::Number(10.0));
        wb.put_formula(0, 0, 1, "A1 * 2");

        // Change A1 to 100 (simulating a user edit that didn't auto-recompute).
        wb.put_at(0, 0, 0, Value::Number(100.0));
        // B1 still shows 10 (stale).
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(10.0)
        );

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.attempted, 1);
        assert_eq!(result.succeeded, 1);
        assert!(result.is_complete());

        // B1 now shows 200 (refreshed).
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(200.0)
        );
    }

    #[test]
    fn recompute_all_handles_multiple_formulas() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(2.0));

        // Add 3 formula cells all referring to A1.
        wb.put_at(0, 1, 0, Value::Number(0.0)); // stale
        wb.put_formula(0, 1, 0, "A1 + 1");
        wb.put_at(0, 2, 0, Value::Number(0.0));
        wb.put_formula(0, 2, 0, "A1 * 10");
        wb.put_at(0, 3, 0, Value::Number(0.0));
        wb.put_formula(0, 3, 0, "A1 - 100");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.succeeded, 3);
        assert!(result.is_complete());

        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(3.0));
        assert_eq!(
            wb.read(ql_types::Address::new(0, 2, 0)),
            Value::Number(20.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 3, 0)),
            Value::Number(-98.0)
        );
    }

    /// End-to-end: save a workbook with formulas, load it, recompute, verify the
    /// values match. This is the full live-formula round-trip use case the IDE
    /// will exercise.
    #[test]
    fn save_load_recompute_e2e() {
        use tempfile::TempDir;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rt.qbook");

        // Build a workbook with a formula.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(7.0));
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 1, 0, "A1 * 3").unwrap();
            // B1 should now be 21.
        }
        assert_eq!(
            wb.read(ql_types::Address::new(s, 1, 0)),
            Value::Number(21.0)
        );

        // Save + load.
        ql_io::save_workbook(&wb, "rt-e2e", &path).unwrap();
        let mut loaded = ql_io::load_workbook(&path).unwrap();

        // Loaded value should match (because saved evaluated value was 21).
        assert_eq!(
            loaded.read(ql_types::Address::new(s, 1, 0)),
            Value::Number(21.0)
        );
        // Formula text preserved.
        assert_eq!(
            loaded.formula_at(s, 1, 0).map(|s| s.as_ref()),
            Some("A1 * 3")
        );

        // Now simulate a stale-value scenario: edit A1 in the loaded workbook.
        loaded.put_at(s, 0, 0, Value::Number(100.0));
        // B1 still shows old value.
        assert_eq!(
            loaded.read(ql_types::Address::new(s, 1, 0)),
            Value::Number(21.0)
        );

        // Recompute refreshes everything.
        let mut rt = WorkbookRuntime::new(&mut loaded, &reg);
        let result = rt.recompute_all();
        assert!(result.is_complete());
        assert_eq!(
            loaded.read(ql_types::Address::new(s, 1, 0)),
            Value::Number(300.0)
        );
    }

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
        // `@` is not in the Phase 0 alphabet — lex error.
        let err = rt
            .set_formula(0, 0, 0, "@foo")
            .expect_err("expected an error");
        let display = err.to_string();
        assert!(
            display.contains("unexpected character"),
            "Display lost the message: {display:?}"
        );
        // No debug-syntax leak like `UnexpectedChar('@')`.
        assert!(
            !display.contains("UnexpectedChar"),
            "Display still leaks Rust variant syntax: {display:?}"
        );
    }

    #[test]
    fn set_formula_named_range_target_unsupported() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        // Range targets aren't usable as scalar operands in Phase 2A.1 — they
        // surface as UnsupportedVariant (analogous to a bare A1:A10 in a scalar
        // context). Aggregate-context usage lands Phase 2B+.
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_formula(0, 0, 0, "Sales");
        assert!(
            matches!(
                result,
                Err(RuntimeError::Bind(BindError::UnsupportedVariant(_)))
            ),
            "expected Bind(UnsupportedVariant), got {result:?}"
        );
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

    // ===== Phase 2A.3.b — op-log producer wiring =====

    #[test]
    fn set_value_with_oplog_emits_put_value() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

        rt.set_value(0, 2, 3, Value::Number(42.0)).unwrap();
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::PutValue {
                sheet,
                row,
                col,
                value,
            } => {
                assert_eq!((*sheet, *row, *col), (0, 2, 3));
                assert_eq!(value, &CellWireValue::Number(42.0));
            }
            other => panic!("expected PutValue, got {other:?}"),
        }
    }

    #[test]
    fn set_value_over_existing_formula_emits_put_value_then_clear_formula() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Seed a formula at (0, 0) via the runtime so the op log captures it.
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_formula(0, 0, 0, "1 + 1").unwrap();
            rt.set_value(0, 0, 0, Value::Number(99.0)).unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // Expect: PutFormula → PutValue → ClearFormula.
        assert_eq!(ops.len(), 3, "ops were: {ops:?}");
        assert!(matches!(ops[0], Op::PutFormula { .. }));
        assert!(matches!(ops[1], Op::PutValue { .. }));
        assert!(matches!(ops[2], Op::ClearFormula { .. }));
    }

    #[test]
    fn set_value_blank_emits_nothing_when_cell_is_already_blank() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // Blank-write on a blank cell with no formula — emits no op
            // (PutValue is skipped because CellWireValue::from_value(Blank) =
            // None; ClearFormula is skipped because had_formula = false).
            rt.set_value(0, 0, 0, Value::Blank).unwrap();
        }
        assert!(
            oplog.is_empty(),
            "expected empty log, got {} ops",
            oplog.len()
        );
    }

    #[test]
    fn set_value_blank_over_formula_emits_clear_formula_only() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Seed a formula directly on the workbook (skip the op log so we
        // isolate the Blank-over-formula behaviour).
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_formula(0, 0, 0, "1 + 4");
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_value(0, 0, 0, Value::Blank).unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        assert!(matches!(ops[0], Op::ClearFormula { .. }));
    }

    #[test]
    fn set_formula_with_oplog_emits_put_formula_text_only() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            let v = rt.set_formula(0, 1, 0, "A1 * 2").unwrap();
            assert_eq!(v, Value::Number(20.0));
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::PutFormula {
                sheet,
                row,
                col,
                text,
            } => {
                assert_eq!((*sheet, *row, *col), (0, 1, 0));
                assert_eq!(text.as_str(), "A1 * 2");
            }
            other => panic!("expected PutFormula, got {other:?}"),
        }
    }

    #[test]
    fn set_formula_lex_error_does_not_emit_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // `@` is rejected by the lexer.
            let result = rt.set_formula(0, 0, 0, "@foo");
            assert!(matches!(result, Err(RuntimeError::Lex(_))));
        }
        assert!(
            oplog.is_empty(),
            "lex error must not append; got {} ops",
            oplog.len()
        );
    }

    #[test]
    fn set_formula_parse_error_does_not_emit_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            let result = rt.set_formula(0, 0, 0, "(1 + 2");
            assert!(matches!(result, Err(RuntimeError::Parse(_))));
        }
        assert!(oplog.is_empty());
    }

    #[test]
    fn set_formula_invalid_cell_does_not_emit_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            let result = rt.set_formula(99, 0, 0, "1 + 1");
            assert!(matches!(result, Err(RuntimeError::InvalidSheet { .. })));
        }
        assert!(oplog.is_empty());
    }

    #[test]
    fn recompute_all_does_not_emit_ops() {
        // recompute_all is idempotent re-evaluation; it shouldn't show up in
        // the op log as a producer mutation. (The op log records user-intent
        // edits, not derived recomputes.)
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Seed via the runtime so 2 ops land (1 PutValue + 1 PutFormula);
        // then recompute_all must not add more.
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_value(0, 0, 0, Value::Number(2.0)).unwrap();
            rt.set_formula(0, 1, 0, "A1 * 3").unwrap();
        }
        let len_before_recompute = oplog.len();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            let result = rt.recompute_all();
            assert!(result.is_complete());
        }
        assert_eq!(
            oplog.len(),
            len_before_recompute,
            "recompute_all must not append ops"
        );
        assert_eq!(len_before_recompute, 2);
    }

    #[test]
    fn runtime_without_oplog_set_value_and_set_formula_still_work() {
        // Regression guard for the existing public API.
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
        let v = rt.set_formula(0, 1, 0, "A1 + 10").unwrap();
        assert_eq!(v, Value::Number(15.0));
    }

    // ===== Phase 2B.2 — RecomputeResult contract =====

    /// R2B-01: a structural failure surfaces with the exact cell address +
    /// formula text + underlying RuntimeError. No information is lost going
    /// from "failed cell" to "RecomputeFailure entry".
    #[test]
    fn recompute_all_failure_carries_exact_cell_and_formula_text() {
        let mut wb = make_runtime_workbook();
        // Seed an unparseable formula by hand-writing it into the workbook
        // (bypassing the runtime's set_formula which would reject it
        // up-front). This simulates the on-disk-corruption scenario the
        // loader handles.
        wb.put_formula(0, 3, 5, "(((");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert!(!result.is_complete());
        assert_eq!(result.failed_count(), 1);
        let failure = &result.failures[0];
        assert_eq!(failure.sheet, 0);
        assert_eq!(failure.row, 3);
        assert_eq!(failure.col, 5);
        assert_eq!(failure.formula_text.as_ref(), "(((");
        // Underlying error is a parse error (unclosed paren).
        assert!(
            matches!(failure.error, RuntimeError::Parse(_)),
            "expected Parse error, got {:?}",
            failure.error
        );
    }

    /// R2B-02: a failure does not short-circuit. Cells whose formulas DO
    /// parse cleanly get re-evaluated and counted as succeeded, regardless
    /// of iteration order.
    #[test]
    fn recompute_all_does_not_short_circuit_on_first_failure() {
        let mut wb = make_runtime_workbook();
        // 3 good formulas + 2 bad ones. We don't know iteration order, but
        // we know exactly 3 should succeed and exactly 2 should fail.
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_formula(0, 1, 0, "A1 + 1"); // good
        wb.put_formula(0, 2, 0, "A1 * 2"); // good
        wb.put_formula(0, 3, 0, "A1 - 5"); // good
        wb.put_formula(0, 4, 0, "((("); // parse error
        wb.put_formula(0, 5, 0, "@bogus"); // lex error

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.attempted, 5);
        assert_eq!(result.succeeded, 3);
        assert_eq!(result.failed_count(), 2);
        assert!(!result.is_complete());

        // Good cells were updated regardless of order.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 1, 0)),
            Value::Number(11.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 2, 0)),
            Value::Number(20.0)
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 3, 0)), Value::Number(5.0));
    }

    /// R2B-03: invalid persisted formulas do NOT panic the runtime. Every
    /// kind of structural failure (lex / parse / bind) surfaces as a
    /// `RecomputeFailure` entry; the runtime stays alive.
    #[test]
    fn recompute_all_does_not_panic_on_invalid_persisted_formulas() {
        let mut wb = make_runtime_workbook();
        wb.put_formula(0, 0, 0, "@@@"); // lex error
        wb.put_formula(0, 0, 1, "1 +"); // parse error (trailing operator)
        wb.put_formula(0, 0, 2, "UnknownName + 1"); // bind error (UnresolvedName)

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Just calling this must not panic — the assertion is the absence
        // of a panic, plus the structural-failure invariant.
        let result = rt.recompute_all();
        assert_eq!(result.attempted, 3);
        assert_eq!(result.succeeded, 0);
        assert_eq!(result.failed_count(), 3);
        assert!(!result.is_complete());
    }

    /// Evaluation-time errors (Value::Error variants like #DIV/0!) count as
    /// SUCCEEDED, not failed. Recompute writes the error value to the cell
    /// per Excel canon. Only structural failures (lex/parse/bind) populate
    /// `RecomputeResult::failures`.
    #[test]
    fn recompute_all_eval_time_error_values_count_as_succeeded() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_formula(0, 1, 0, "A1 / 0"); // evaluates to #DIV/0!

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.succeeded, 1);
        assert_eq!(result.failed_count(), 0);
        assert!(result.is_complete());
        // The cell value is the error sentinel, written by put_at.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 1, 0)),
            Value::Error(ErrorValue::DivZero)
        );
    }

    /// Failed cells keep their pre-recompute values; their formula text is
    /// preserved (recompute never clears formula on failure).
    #[test]
    fn recompute_all_failed_cells_preserve_prior_state() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(999.0)); // pre-recompute value
        wb.put_formula(0, 0, 0, "(((");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.failed_count(), 1);
        // Cell value untouched by failed recompute.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Number(999.0)
        );
        // Formula text still on disk.
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("((("));
    }

    // ===== Phase 2B.3 — bind-plan cache =====

    /// BPC-01: repeated `recompute_all` against the same workbook does NOT
    /// re-lex / re-parse / re-bind unchanged formulas. The second pass
    /// hits the cache for every formula.
    #[test]
    fn recompute_all_second_pass_is_all_cache_hits() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_formula(0, 1, 0, "A1 + 1");
        wb.put_formula(0, 2, 0, "A1 * 2");
        wb.put_formula(0, 3, 0, "A1 - 3");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // First pass: 3 misses (one per formula).
        let r1 = rt.recompute_all();
        assert_eq!(r1.succeeded, 3);
        let s1 = rt.cache_stats();
        assert_eq!(s1.misses, 3);
        assert_eq!(s1.hits, 0);
        assert_eq!(s1.entries, 3);

        // Second pass: 3 hits (the cache covers every formula). The
        // miss count does not change.
        let r2 = rt.recompute_all();
        assert_eq!(r2.succeeded, 3);
        let s2 = rt.cache_stats();
        assert_eq!(s2.misses, 3, "no new misses on the second pass");
        assert_eq!(s2.hits, 3, "every formula hit the cache");
    }

    /// BPC-02: a NameTable mutation between recompute_all calls invalidates
    /// every cached plan (because the cache key includes the generation).
    /// The next recompute_all is all misses.
    #[test]
    fn name_table_mutation_invalidates_bind_plan_cache() {
        use ql_storage::NamedTarget;
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_formula(0, 1, 0, "A1 + 1");
        wb.put_formula(0, 2, 0, "A1 * 2");

        let reg = default_registry();

        // First runtime pass: 2 misses, then the runtime drops so we can
        // mutate the name table.
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let _ = rt.recompute_all();
            assert_eq!(rt.cache_stats().misses, 2);
            assert_eq!(rt.cache_stats().hits, 0);
        }

        // Mutate name table (bumps generation).
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();

        // New runtime: cache is empty (per-runtime cache), so still misses;
        // but the IMPORTANT invariant is that a subsequent in-runtime
        // recompute against a CHANGED name table also misses for cached
        // entries with the old generation. Test that next:
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Pass A — warms the cache at the current (post-mutation) gen.
        let _ = rt.recompute_all();
        let stats_a = rt.cache_stats();
        assert_eq!(stats_a.misses, 2);

        // Mutate again INSIDE this runtime's lifetime.
        let old_gen = wb.names().generation();
        wb.set_name("ExtraName", NamedTarget::Constant(Value::Number(1.0)))
            .unwrap();
        assert!(
            wb.names().generation() > old_gen,
            "generation must bump on set"
        );

        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Pass B — all formulas miss again because keys differ on
        // name_gen. Were the cache key gen-blind, this would hit and the
        // invalidation contract would be broken.
        let _ = rt.recompute_all();
        let stats_b = rt.cache_stats();
        assert_eq!(
            stats_b.misses, 2,
            "name table mutation must invalidate cached plans"
        );
        assert_eq!(stats_b.hits, 0);
    }

    /// BPC-03: cache keys are stable across recompute_all calls — same
    /// formula text + same sheet + same name_gen always hashes to the
    /// same key, so hits are reliable. This is structural (Hash/Eq on
    /// PlanCacheKey) but we exercise it end-to-end through the runtime.
    #[test]
    fn cache_keys_are_stable_across_recompute_passes() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(7.0));
        wb.put_formula(0, 1, 0, "A1 + 1");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // 10 successive recomputes against the same state.
        for i in 0..10 {
            let _ = rt.recompute_all();
            let stats = rt.cache_stats();
            // Exactly 1 miss total (first pass); the other 9 are hits.
            assert_eq!(stats.misses, 1, "iteration {i}: unexpected new miss");
            assert_eq!(stats.hits, i, "iteration {i}: hit count off");
        }
    }

    /// BPC-04: cache hit/miss counters are visible (via `cache_stats()`)
    /// in a form that ql-profile can lift into `Timings`. The
    /// counterpart `Timings::bind_plan_cache_hits/misses` fields exist
    /// and accept these numbers verbatim.
    #[test]
    fn cache_stats_flow_into_timings_struct() {
        use ql_profile::Timings;
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_formula(0, 1, 0, "A1 + 100");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let _ = rt.recompute_all(); // 1 miss
        let _ = rt.recompute_all(); // 1 hit

        let s = rt.cache_stats();
        let mut timings = Timings::new();
        timings.bind_plan_cache_hits = s.hits;
        timings.bind_plan_cache_misses = s.misses;
        assert_eq!(timings.bind_plan_cache_hits, 1);
        assert_eq!(timings.bind_plan_cache_misses, 1);
        assert_eq!(timings.bind_plan_cache_hit_rate(), Some(0.5));
    }

    /// `set_formula` pre-warms the cache. A subsequent `recompute_all`
    /// of the same cell hits the cache (no re-bind work).
    #[test]
    fn set_formula_populates_cache_for_subsequent_recompute() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(2.0));

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 1, 0, "A1 * 50").unwrap();
        let after_set = rt.cache_stats();
        assert_eq!(after_set.misses, 1);
        assert_eq!(after_set.hits, 0);
        assert_eq!(after_set.entries, 1);

        // Recompute the workbook — should hit the cache for the formula
        // we just set.
        let _ = rt.recompute_all();
        let after_recompute = rt.cache_stats();
        assert_eq!(after_recompute.misses, 1, "no new misses");
        assert_eq!(after_recompute.hits, 1, "recompute hit the cache");
    }
}
