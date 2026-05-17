//! Reference-aware function impls.
//!
//! - **W5-RT-2 / Step 2** — address-only batch: ROW / COLUMN / ROWS /
//!   COLUMNS (`ArgContract::Eager`).
//! - **W5-RT-3 / Step 3** — information batch: ISREF
//!   (`ArgContract::LazyShape` — first user-facing fn through that
//!   contract) + ISFORMULA (`Eager` + `ReferenceQuery::is_formula_at`).
//! - **W5-RT-4 / Step 4** — text batch: FORMULATEXT (`Eager` +
//!   `ReferenceQuery::formula_text_at` — prepends `=` to stored text per
//!   Excel canon). **CLOSES the RT-V1-01 mini-phase.**
//!
//! Design doc: `docs/architecture/2026-05-17-reference-tier-design.md` § 5.6.
//! Audit summary: `docs/audits/2026-05-17-reference-tier-audit-summary.md`.
//!
//! ## v1 stance recap
//!
//! - **0-vs-1-indexed:** `RowId` / `ColId` are `u32` 0-indexed internally.
//!   ROW/COLUMN convert to Excel's 1-indexed output by `+ 1`.
//! - **`#REF!` propagation:** any `RefArg::Error(ev)` arg propagates `ev`
//!   first (per HIGH-F closure).
//! - **Non-reference args:** `Scalar` / `Shape` / `Array` (for ROW/COLUMN
//!   only; ROWS/COLUMNS accept arrays) → `#VALUE!`. ISFORMULA returns
//!   `#N/A` per Microsoft canon (documented IronCalc-#VALUE! divergence).
//! - **Arity mismatch:** > 1 arg for ROW/COLUMN → `#N/A`; wrong arity for
//!   ROWS/COLUMNS/ISREF/ISFORMULA → `#N/A`.
//! - **Calling-cell context:** `ROW()` / `COLUMN()` with no arg use
//!   `RefContext::formula_cell`. If `None` (test envs without a formula
//!   cell), return `#REF!`.
//! - **Spill defer:** in scalar context, multi-cell range arg returns
//!   top-left (Excel pre-365 implicit intersection). At the cell boundary,
//!   the dispatcher guard in `eval_at_cell_boundary` intercepts and
//!   returns `#CALC!` — implemented in W5-RT-1, NOT here.
//! - **Lazy contract (ISREF):** `ArgContract::LazyShape` means the
//!   dispatcher's `materialize_ref_arg_lazy` produces `RefArg::Shape(_)`
//!   without ever calling `eval_scalar_with_cache`. `ISREF(1/0)` returns
//!   FALSE without surfacing `#DIV/0!`; `ISREF(NOW())` does NOT mark the
//!   formula volatile (per Step 3.1 walker fix).

use ql_types::{ErrorValue, Value};

use crate::reference_aware_fns::{PlanKind, RefArg, RefContext};

/// **ROW([ref])** — returns the 1-indexed row number of `ref`'s top-left
/// cell, or of the calling cell if `ref` is omitted.
///
/// - `ROW()` returns the calling cell's 1-indexed row (or `#REF!` if no
///   calling cell is known — typical for non-cell evaluation paths).
/// - `ROW(A1)` returns `1`.
/// - `ROW(A1:B3)` returns `1` in scalar context (top-left row). At the
///   cell boundary the dispatcher guard rejects with `#CALC!` (HIGH-E
///   closure in W5-RT-1).
/// - `ROW("text")` / `ROW(1+2)` → `#VALUE!`.
/// - `ROW(#REF!)` → `#REF!` (error propagation).
/// - `ROW(arg1, arg2)` → `#N/A` (arity).
///
/// **v1 scope reduction (S2-HIGH-3 documentation closure):**
/// `ROW(SUM(A1:A3))` does NOT reach the design's `#VALUE!` outcome —
/// the inner `SUM(A1:A3)` literal-range argument bind-fails because
/// S1-MED-γ deferred AggregateArg-side `Expr::RangeRef` lowering (the
/// scalar/range-aware/unified dispatcher arms would each need new
/// consumer logic for `ExprPlan::RangeRef`). The named-range form —
/// `ROW(SUM(NamedRange))` — DOES work via the existing
/// `AggregateNameRef` path and evaluates eagerly; ROW receives a
/// Scalar arg and returns `#VALUE!` per the design. Lifting the
/// AggregateArg defer is a post-RT-V1 follow-up.
pub fn row(args: &[RefArg], ctx: &RefContext) -> Value {
    match args.len() {
        0 => match ctx.formula_cell {
            Some(addr) => Value::number(f64::from(addr.row) + 1.0),
            None => Value::Error(ErrorValue::Ref),
        },
        1 => match &args[0] {
            // Error propagation first (HIGH-F closure).
            RefArg::Error(ev) => Value::Error(*ev),
            RefArg::Reference { address, .. } => Value::number(f64::from(address.row) + 1.0),
            RefArg::Range { range, .. } => Value::number(f64::from(range.start_row) + 1.0),
            // ROW does NOT accept array literals (only ROWS does).
            // Microsoft canon: `ROW({1,2,3})` is array-context spill;
            // v1 returns `#VALUE!` in scalar context.
            RefArg::Array(_) => Value::Error(ErrorValue::Value),
            // Scalar (non-reference literal / eager-eval result) and Shape
            // (LazyShape — but ROW uses Eager contract, so Shape is
            // unreachable here): not a reference.
            RefArg::Scalar(_) | RefArg::Shape(_) => Value::Error(ErrorValue::Value),
        },
        _ => Value::Error(ErrorValue::NA),
    }
}

/// **COLUMN([ref])** — symmetric to [`row`], returning the 1-indexed
/// column number.
pub fn column(args: &[RefArg], ctx: &RefContext) -> Value {
    match args.len() {
        0 => match ctx.formula_cell {
            Some(addr) => Value::number(f64::from(addr.col) + 1.0),
            None => Value::Error(ErrorValue::Ref),
        },
        1 => match &args[0] {
            RefArg::Error(ev) => Value::Error(*ev),
            RefArg::Reference { address, .. } => Value::number(f64::from(address.col) + 1.0),
            RefArg::Range { range, .. } => Value::number(f64::from(range.start_col) + 1.0),
            RefArg::Array(_) => Value::Error(ErrorValue::Value),
            RefArg::Scalar(_) | RefArg::Shape(_) => Value::Error(ErrorValue::Value),
        },
        _ => Value::Error(ErrorValue::NA),
    }
}

/// **ROWS(arg)** — returns the row count of `arg`.
///
/// - `ROWS(A1)` → `1` (single cell).
/// - `ROWS(A1:B3)` → `3` (range).
/// - `ROWS(A:A)` → `1_048_576` (whole-column expands to `MAX_ROW + 1`).
/// - `ROWS({1,2,3;4,5,6})` → `2` (array literal — Microsoft canon, HIGH-C
///   closure in W5-RT-1).
/// - `ROWS(#REF!)` → `#REF!`.
/// - `ROWS("text")` / `ROWS(1+2)` → `#VALUE!`.
/// - `ROWS()` / `ROWS(a, b)` → `#N/A`.
pub fn rows(args: &[RefArg], _ctx: &RefContext) -> Value {
    match args {
        [RefArg::Error(ev)] => Value::Error(*ev),
        [RefArg::Range { range, .. }] => {
            // Inclusive count: end_row - start_row + 1. WholeColumn binds
            // to start_row=0, end_row=MAX_ROW=1_048_575 → 1_048_576.
            //
            // **Step 2.1 (S2-MED-β defensive guard):** `Range::new`
            // normalizes corners so `end >= start` for binder-produced
            // ranges. Public-API paths (qbook import, programmatic
            // `NamedTarget::Range(...)` construction) bypass that
            // normalization; an inverted range would underflow `u32`
            // subtraction. Surface `#REF!` via `checked_sub` rather than
            // panic or wrap.
            match range.end_row.checked_sub(range.start_row) {
                Some(diff) => Value::number(f64::from(diff + 1)),
                None => Value::Error(ErrorValue::Ref),
            }
        }
        [RefArg::Reference { .. }] => Value::number(1.0),
        // Array literal: row count = the array's first dimension.
        [RefArg::Array(av)] => Value::number(f64::from(av.rows())),
        [RefArg::Scalar(_) | RefArg::Shape(_)] => Value::Error(ErrorValue::Value),
        _ => Value::Error(ErrorValue::NA),
    }
}

/// **COLUMNS(arg)** — symmetric to [`rows`], returning the column count.
pub fn columns(args: &[RefArg], _ctx: &RefContext) -> Value {
    match args {
        [RefArg::Error(ev)] => Value::Error(*ev),
        [RefArg::Range { range, .. }] => {
            // **Step 2.1 (S2-MED-β defensive guard):** see `rows` for
            // rationale — `checked_sub` defends against inverted ranges
            // from public-API paths that bypass `Range::new` normalization.
            match range.end_col.checked_sub(range.start_col) {
                Some(diff) => Value::number(f64::from(diff + 1)),
                None => Value::Error(ErrorValue::Ref),
            }
        }
        [RefArg::Reference { .. }] => Value::number(1.0),
        [RefArg::Array(av)] => Value::number(f64::from(av.cols())),
        [RefArg::Scalar(_) | RefArg::Shape(_)] => Value::Error(ErrorValue::Value),
        _ => Value::Error(ErrorValue::NA),
    }
}

// =====================================================================
// W5-RT-3 (RT-V1-01 Step 3): ISREF + ISFORMULA — information-fn batch
// =====================================================================
//
// ISREF uses `ArgContract::LazyShape` (the FIRST user-facing fn through
// that contract — Step 1's tests validated the path via placeholders).
// The dispatcher's `materialize_ref_arg_lazy` produces `RefArg::Shape(_)`
// without evaluating the arg, so `ISREF(1/0) = FALSE` does NOT surface
// `#DIV/0!` (HIGH-B closure from pre-review).
//
// ISFORMULA uses `ArgContract::Eager` + queries the workbook via
// `RefContext::workbook.is_formula_at` (the `ReferenceQuery` trait the
// Step 1 infrastructure wired). Single-cell Reference / 1×1 Range arg
// → call the workbook query; multi-cell range / Array / Scalar /
// Shape → `#N/A` per Microsoft canon (HIGH-D / S1-MEDIUM-1 closures
// in the design).
//
// FORMULATEXT (Step 4) follows the same Eager-contract pattern.

/// **ISREF(arg)** — TRUE iff `arg`'s expression shape is a reference
/// (single-cell or range) OR a reference-returning function. Does NOT
/// evaluate `arg` (HIGH-B closure: `ISREF(1/0)` returns FALSE without
/// surfacing `#DIV/0!`).
///
/// - `ISREF(A1)` → TRUE.
/// - `ISREF(A1:B3)` → TRUE.
/// - `ISREF(NamedCell)` → TRUE (resolves to AggregateNameRef → RangeRef).
/// - `ISREF(SUM(NamedRange))` → FALSE (SUM does not return a reference).
///   Note: `ISREF(SUM(A1:A3))` literal-range form bind-fails per
///   S1-MED-γ AggregateArg defer (pinned by `isref_of_sum_literal_range_bind_fails_v1_scope`).
/// - `ISREF(1+2)` → FALSE.
/// - `ISREF(123)` / `ISREF("text")` → FALSE.
/// - `ISREF(1/0)` → FALSE (no eval; div-by-zero not surfaced).
/// - `ISREF(#REF!)` → FALSE (`#REF!` literal is not a reference).
/// - `ISREF()` / `ISREF(a, b)` → `#N/A` (arity).
///
/// v1 has no reference-returning fns (OFFSET / INDIRECT deferred), so
/// `ISREF(<any function call>)` always returns FALSE. When reference-
/// returning fns ship in a follow-up, `PlanKind::Function { returns_reference }`
/// will distinguish; the v1 dispatcher emits `returns_reference: false`
/// unconditionally.
pub fn isref(args: &[RefArg], _ctx: &RefContext) -> Value {
    match args {
        [RefArg::Shape(PlanKind::CellRef | PlanKind::RangeRef)] => Value::Boolean(true),
        [RefArg::Shape(PlanKind::Function {
            returns_reference: true,
        })] => Value::Boolean(true),
        [RefArg::Shape(_)] => Value::Boolean(false),
        // Defensive: Eager-contract args would surface as Reference /
        // Range / Scalar / Array / Error. ISREF uses LazyShape so the
        // dispatcher emits only `RefArg::Shape(_)` for the arg slot;
        // these arms are unreachable under the contract but kept for
        // defense-in-depth.
        [RefArg::Reference { .. } | RefArg::Range { .. }] => Value::Boolean(true),
        [RefArg::Scalar(_) | RefArg::Array(_) | RefArg::Error(_)] => Value::Boolean(false),
        _ => Value::Error(ErrorValue::NA),
    }
}

/// **ISFORMULA(ref)** — TRUE iff the cell at `ref` stores a formula
/// (vs. literal / blank). Queries workbook storage via `RefContext::
/// workbook.is_formula_at`.
///
/// - `ISFORMULA(A1)` where A1 = `=1+2` → TRUE.
/// - `ISFORMULA(A1)` where A1 holds a literal `5` → FALSE.
/// - `ISFORMULA(BlankCell)` → FALSE.
/// - `ISFORMULA(A1:B3)` → `#N/A` (multi-cell range; per Microsoft canon).
/// - `ISFORMULA("text")` / `ISFORMULA(123)` / `ISFORMULA(SUM(NamedRange))`
///   → `#N/A` (non-reference arg). The design diverges here from the
///   `#VALUE!` IronCalc returns; Microsoft canon says `#N/A` for any
///   non-reference arg (Microsoft 2024). Note: `ISFORMULA(SUM(A1:A3))`
///   literal-range form bind-fails per S1-MED-γ AggregateArg defer
///   (pinned by `isformula_of_sum_literal_range_bind_fails_v1_scope`).
/// - `ISFORMULA(#REF!)` → `#REF!` (error propagation).
/// - `ISFORMULA()` / `ISFORMULA(a, b)` → `#N/A` (arity).
///
/// v1 cost (design § 8 R8): the dep-walker registers a value-dep on
/// the referenced cell, so the formula recomputes when the cell's
/// value changes — even though only the formula-status (formula vs
/// literal) matters. A future `formula_status_deps` kind would fix
/// this; out of v1 scope.
pub fn isformula(args: &[RefArg], ctx: &RefContext) -> Value {
    match args {
        [RefArg::Error(ev)] => Value::Error(*ev),
        [RefArg::Reference { address, .. }] => Value::Boolean(ctx.workbook.is_formula_at(
            address.sheet,
            address.row,
            address.col,
        )),
        // 1×1 range: treat as single-cell.
        [RefArg::Range { range, .. }]
            if range.start_row == range.end_row && range.start_col == range.end_col =>
        {
            Value::Boolean(ctx.workbook.is_formula_at(
                range.sheet,
                range.start_row,
                range.start_col,
            ))
        }
        // Multi-cell range OR any non-reference shape → #N/A per
        // Microsoft canon (design § 2.4 MEDIUM-1 closure).
        [RefArg::Range { .. } | RefArg::Array(_) | RefArg::Scalar(_) | RefArg::Shape(_)] => {
            Value::Error(ErrorValue::NA)
        }
        _ => Value::Error(ErrorValue::NA),
    }
}

// =====================================================================
// W5-RT-4 (RT-V1-01 Step 4): FORMULATEXT — text batch (CLOSES mini-phase)
// =====================================================================

/// **FORMULATEXT(ref)** — returns the canonical formula text at `ref`
/// with a leading `=` (e.g., `"=SUM(B1:B3)"`). Queries workbook storage
/// via `RefContext::workbook.formula_text_at`.
///
/// - `FORMULATEXT(A1)` where A1 = `=1+2` → `"=1+2"`.
/// - `FORMULATEXT(BlankCell)` / `FORMULATEXT(LiteralCell)` → `#N/A`
///   (no formula).
/// - `FORMULATEXT(A1:A1)` → same as `FORMULATEXT(A1)` (1×1-range
///   single-cell treatment).
/// - `FORMULATEXT(A1:B3)` → `#N/A` (multi-cell range; Microsoft canon).
/// - `FORMULATEXT("text")` / `FORMULATEXT(123)` / non-reference →
///   `#N/A` (Microsoft canon; IronCalc returns `#ERROR!` divergence
///   documented).
/// - `FORMULATEXT(#REF!)` → `#REF!` (error propagation).
/// - `FORMULATEXT()` / arity > 1 → `#N/A`.
/// - Note: `FORMULATEXT(SUM(A1:A3))` literal-range form bind-fails per
///   S1-MED-γ AggregateArg defer (pinned in `reference_fns_step4_e2e`).
///   The named-range form `FORMULATEXT(SUM(NamedRange))` evaluates
///   eagerly and returns `#N/A` (SUM result is Scalar, not Reference).
///
/// **Producer API canonicalization divergence (S4-HIGH-1 doc closure):**
/// the stored formula text depends on which producer API wrote it:
/// - `WorkbookRuntime::set_formula(...)` canonicalizes via
///   `parse → print_with(...EnUs...)`. `FORMULATEXT` returns the
///   canonical A1/EnUs form with leading `=`.
/// - `WorkbookTransaction::put_formula(...)` stores raw user-typed text
///   verbatim (parsing/binding only for validation). `FORMULATEXT`
///   returns the raw text with leading `=`.
///
/// Both paths satisfy the leading-`=` invariant; the canonicalization
/// invariant holds for set_formula only. v1-accepted divergence;
/// future post-RT-V1 cycle may align the two paths.
///
/// **Producer/replay self-reference divergence (S4-HIGH-2 / parallel
/// to S3-HIGH-5 for ISFORMULA):** `=FORMULATEXT(A1)` typed at A1 returns
/// `#N/A` on producer side (`set_formula` evaluates BEFORE installing
/// the formula → `formula_text_at(A1) = None`) but `"=FORMULATEXT(A1)"`
/// on replay (op-log restores formula text BEFORE recompute). Documented
/// v1 divergence; fix is a workbook_runtime restructure out of v1 scope.
/// Pinned by `formulatext_self_reference_returns_na_during_set_formula_v1_pin`.
///
/// **Source-text retention (HIGH-D closure from pre-review):** the
/// workbook stores canonical printer-output formula text (no leading
/// `=`) via `Workbook::formula_at`. `ReferenceQuery::formula_text_at`
/// (impl on `WorkbookEnv` in `ql-exec/src/env.rs`) prepends `=` at
/// the boundary so callers receive the Excel-canonical FORMULATEXT
/// shape directly.
///
/// v1 cost: same as ISFORMULA — value-deps on referenced cell instead
/// of formula-status / formula-text deps. Acceptable per design § 8 R8.
pub fn formulatext(args: &[RefArg], ctx: &RefContext) -> Value {
    match args {
        [RefArg::Error(ev)] => Value::Error(*ev),
        [RefArg::Reference { address, .. }] => {
            match ctx
                .workbook
                .formula_text_at(address.sheet, address.row, address.col)
            {
                Some(text) => Value::Text(text.into()),
                None => Value::Error(ErrorValue::NA),
            }
        }
        // 1×1 range: treat as single-cell.
        [RefArg::Range { range, .. }]
            if range.start_row == range.end_row && range.start_col == range.end_col =>
        {
            match ctx
                .workbook
                .formula_text_at(range.sheet, range.start_row, range.start_col)
            {
                Some(text) => Value::Text(text.into()),
                None => Value::Error(ErrorValue::NA),
            }
        }
        // Multi-cell range OR any non-reference shape → #N/A per
        // Microsoft canon (matches ISFORMULA's pattern).
        [RefArg::Range { .. } | RefArg::Array(_) | RefArg::Scalar(_) | RefArg::Shape(_)] => {
            Value::Error(ErrorValue::NA)
        }
        _ => Value::Error(ErrorValue::NA),
    }
}

// =====================================================================
// Tests — each fn ≥ 8 per the design § 7 + audit-discipline MEDIUM-δ
// =====================================================================
//
// LibreOffice 7.6 cross-checks (per design § 7 LOW-4 closure):
//   ROW(B5) = 5
//   COLUMN(B5) = 2
//   ROWS(A1:A5) = 5
//   ROWS(A:A) = 1048576
//   COLUMNS(A1:E1) = 5
//   COLUMNS(1:1) = 16384
//   ROWS({1,2,3;4,5,6}) = 2
//   COLUMNS({1,2,3;4,5,6}) = 3

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reference_aware_fns::{PlanKind, NO_OP_REFERENCE_QUERY};
    use ql_types::{Address, ArrayValue, Range, DEFAULT_EVAL_CONTEXT};

    fn ctx_no_cell<'a>() -> RefContext<'a> {
        RefContext::new(&DEFAULT_EVAL_CONTEXT, None, &NO_OP_REFERENCE_QUERY)
    }

    fn ctx_at(sheet: u16, row: u32, col: u32) -> RefContext<'static> {
        RefContext::new(
            &DEFAULT_EVAL_CONTEXT,
            Some(Address::new(sheet, row, col)),
            &NO_OP_REFERENCE_QUERY,
        )
    }

    fn cell_ref(sheet: u16, row: u32, col: u32) -> RefArg {
        RefArg::Reference {
            address: Address::new(sheet, row, col),
        }
    }

    fn range_ref(sheet: u16, r1: u32, c1: u32, r2: u32, c2: u32) -> RefArg {
        RefArg::Range {
            range: Range::new(sheet, r1, c1, r2, c2),
            values: vec![],
        }
    }

    // ----- ROW -----

    #[test]
    fn row_of_cell_a1_returns_1() {
        let ctx = ctx_no_cell();
        assert_eq!(row(&[cell_ref(0, 0, 0)], &ctx), Value::number(1.0));
    }

    #[test]
    fn row_of_cell_b5_returns_5() {
        // LibreOffice cross-check: ROW(B5) = 5.
        let ctx = ctx_no_cell();
        assert_eq!(row(&[cell_ref(0, 4, 1)], &ctx), Value::number(5.0));
    }

    #[test]
    fn row_of_range_returns_top_left_row() {
        let ctx = ctx_no_cell();
        // Range A1:B3 → top-left row = 1.
        assert_eq!(row(&[range_ref(0, 0, 0, 2, 1)], &ctx), Value::number(1.0));
        // Range C5:D10 → top-left row = 5.
        assert_eq!(row(&[range_ref(0, 4, 2, 9, 3)], &ctx), Value::number(5.0));
    }

    #[test]
    fn row_zero_arg_with_formula_cell_returns_formula_row() {
        let ctx = ctx_at(0, 6, 2);
        // Formula cell at row 6 (0-indexed) → ROW() = 7.
        assert_eq!(row(&[], &ctx), Value::number(7.0));
    }

    #[test]
    fn row_zero_arg_without_formula_cell_returns_ref() {
        // Test path: no formula cell wired → #REF!.
        let ctx = ctx_no_cell();
        assert_eq!(row(&[], &ctx), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn row_propagates_error_arg() {
        let ctx = ctx_no_cell();
        assert_eq!(
            row(&[RefArg::Error(ErrorValue::Ref)], &ctx),
            Value::Error(ErrorValue::Ref)
        );
        assert_eq!(
            row(&[RefArg::Error(ErrorValue::Name)], &ctx),
            Value::Error(ErrorValue::Name)
        );
    }

    #[test]
    fn row_of_scalar_arg_is_value_error() {
        let ctx = ctx_no_cell();
        assert_eq!(
            row(&[RefArg::Scalar(Value::number(5.0))], &ctx),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            row(&[RefArg::Scalar(Value::Text("hello".into()))], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn row_of_array_literal_is_value_error() {
        let ctx = ctx_no_cell();
        let av = ArrayValue::new(2, 2, vec![Value::number(1.0); 4]).unwrap();
        assert_eq!(
            row(&[RefArg::Array(av)], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn row_of_arity_zero_with_extra_args_returns_na() {
        let ctx = ctx_no_cell();
        assert_eq!(
            row(&[cell_ref(0, 0, 0), cell_ref(0, 0, 0)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    // ----- COLUMN -----

    #[test]
    fn column_of_cell_a1_returns_1() {
        let ctx = ctx_no_cell();
        assert_eq!(column(&[cell_ref(0, 0, 0)], &ctx), Value::number(1.0));
    }

    #[test]
    fn column_of_cell_b5_returns_2() {
        // LibreOffice cross-check: COLUMN(B5) = 2.
        let ctx = ctx_no_cell();
        assert_eq!(column(&[cell_ref(0, 4, 1)], &ctx), Value::number(2.0));
    }

    #[test]
    fn column_of_range_returns_top_left_col() {
        let ctx = ctx_no_cell();
        // Range A1:B3 → top-left col = 1.
        assert_eq!(
            column(&[range_ref(0, 0, 0, 2, 1)], &ctx),
            Value::number(1.0)
        );
        // Range D2:F5 → top-left col = 4.
        assert_eq!(
            column(&[range_ref(0, 1, 3, 4, 5)], &ctx),
            Value::number(4.0)
        );
    }

    #[test]
    fn column_zero_arg_with_formula_cell_returns_formula_col() {
        let ctx = ctx_at(0, 6, 2);
        // Formula cell at col 2 (0-indexed) → COLUMN() = 3.
        assert_eq!(column(&[], &ctx), Value::number(3.0));
    }

    #[test]
    fn column_zero_arg_without_formula_cell_returns_ref() {
        let ctx = ctx_no_cell();
        assert_eq!(column(&[], &ctx), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn column_propagates_error_arg() {
        let ctx = ctx_no_cell();
        assert_eq!(
            column(&[RefArg::Error(ErrorValue::Ref)], &ctx),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn column_of_scalar_arg_is_value_error() {
        let ctx = ctx_no_cell();
        assert_eq!(
            column(&[RefArg::Scalar(Value::number(7.0))], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn column_of_array_literal_is_value_error() {
        let ctx = ctx_no_cell();
        let av = ArrayValue::new(1, 3, vec![Value::number(1.0); 3]).unwrap();
        assert_eq!(
            column(&[RefArg::Array(av)], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    // ----- ROWS -----

    #[test]
    fn rows_of_single_cell_returns_1() {
        let ctx = ctx_no_cell();
        assert_eq!(rows(&[cell_ref(0, 5, 5)], &ctx), Value::number(1.0));
    }

    #[test]
    fn rows_of_range_a1_a5_returns_5() {
        // LibreOffice cross-check: ROWS(A1:A5) = 5.
        let ctx = ctx_no_cell();
        assert_eq!(rows(&[range_ref(0, 0, 0, 4, 0)], &ctx), Value::number(5.0));
    }

    #[test]
    fn rows_of_range_a1_b3_returns_3() {
        let ctx = ctx_no_cell();
        assert_eq!(rows(&[range_ref(0, 0, 0, 2, 1)], &ctx), Value::number(3.0));
    }

    #[test]
    fn rows_of_whole_column_returns_max_row_plus_1() {
        // LibreOffice cross-check: ROWS(A:A) = 1048576 (MAX_ROW=1_048_575 + 1).
        let ctx = ctx_no_cell();
        let r = range_ref(0, 0, 0, ql_types::MAX_ROW, 0);
        assert_eq!(rows(&[r], &ctx), Value::number(1_048_576.0));
    }

    #[test]
    fn rows_of_array_literal_returns_first_dim() {
        // LibreOffice cross-check: ROWS({1,2,3;4,5,6}) = 2.
        let ctx = ctx_no_cell();
        let av = ArrayValue::new(
            2,
            3,
            vec![
                Value::number(1.0),
                Value::number(2.0),
                Value::number(3.0),
                Value::number(4.0),
                Value::number(5.0),
                Value::number(6.0),
            ],
        )
        .unwrap();
        assert_eq!(rows(&[RefArg::Array(av)], &ctx), Value::number(2.0));
    }

    #[test]
    fn rows_propagates_error_arg() {
        let ctx = ctx_no_cell();
        assert_eq!(
            rows(&[RefArg::Error(ErrorValue::Ref)], &ctx),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn rows_of_scalar_arg_is_value_error() {
        let ctx = ctx_no_cell();
        assert_eq!(
            rows(&[RefArg::Scalar(Value::number(0.0))], &ctx),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            rows(&[RefArg::Scalar(Value::Text("text".into()))], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn rows_arity_errors() {
        let ctx = ctx_no_cell();
        assert_eq!(rows(&[], &ctx), Value::Error(ErrorValue::NA));
        assert_eq!(
            rows(&[cell_ref(0, 0, 0), cell_ref(0, 0, 1)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    // ----- COLUMNS -----

    #[test]
    fn columns_of_single_cell_returns_1() {
        let ctx = ctx_no_cell();
        assert_eq!(columns(&[cell_ref(0, 5, 5)], &ctx), Value::number(1.0));
    }

    #[test]
    fn columns_of_range_a1_e1_returns_5() {
        // LibreOffice cross-check: COLUMNS(A1:E1) = 5.
        let ctx = ctx_no_cell();
        assert_eq!(
            columns(&[range_ref(0, 0, 0, 0, 4)], &ctx),
            Value::number(5.0)
        );
    }

    #[test]
    fn columns_of_range_a1_b3_returns_2() {
        let ctx = ctx_no_cell();
        assert_eq!(
            columns(&[range_ref(0, 0, 0, 2, 1)], &ctx),
            Value::number(2.0)
        );
    }

    #[test]
    fn columns_of_whole_row_returns_max_column_plus_1() {
        // LibreOffice cross-check: COLUMNS(1:1) = 16384 (MAX_COLUMN=16_383 + 1).
        let ctx = ctx_no_cell();
        let r = range_ref(0, 0, 0, 0, ql_types::MAX_COLUMN);
        assert_eq!(columns(&[r], &ctx), Value::number(16_384.0));
    }

    #[test]
    fn columns_of_array_literal_returns_second_dim() {
        // LibreOffice cross-check: COLUMNS({1,2,3;4,5,6}) = 3.
        let ctx = ctx_no_cell();
        let av = ArrayValue::new(
            2,
            3,
            vec![
                Value::number(1.0),
                Value::number(2.0),
                Value::number(3.0),
                Value::number(4.0),
                Value::number(5.0),
                Value::number(6.0),
            ],
        )
        .unwrap();
        assert_eq!(columns(&[RefArg::Array(av)], &ctx), Value::number(3.0));
    }

    #[test]
    fn columns_propagates_error_arg() {
        let ctx = ctx_no_cell();
        assert_eq!(
            columns(&[RefArg::Error(ErrorValue::Value)], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn columns_of_scalar_arg_is_value_error() {
        let ctx = ctx_no_cell();
        assert_eq!(
            columns(&[RefArg::Scalar(Value::Boolean(true))], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn columns_arity_errors() {
        let ctx = ctx_no_cell();
        assert_eq!(columns(&[], &ctx), Value::Error(ErrorValue::NA));
        assert_eq!(
            columns(&[range_ref(0, 0, 0, 2, 1), range_ref(0, 0, 0, 0, 0)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    // ----- Cross-cutting: dispatcher won't produce RefArg::Shape with Eager
    // contract, but defensive arms are pinned. -----

    #[test]
    fn row_with_shape_arg_returns_value_error() {
        let ctx = ctx_no_cell();
        // Dispatcher won't produce this with Eager contract, but pin the
        // defensive arm.
        assert_eq!(
            row(&[RefArg::Shape(PlanKind::CellRef)], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn rows_with_shape_arg_returns_value_error() {
        let ctx = ctx_no_cell();
        assert_eq!(
            rows(&[RefArg::Shape(PlanKind::RangeRef)], &ctx),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== ISREF =====
    //
    // ISREF uses ArgContract::LazyShape — the dispatcher produces only
    // `RefArg::Shape(PlanKind)` for the arg slot. Unit tests call the
    // impl directly with `RefArg::Shape(_)` variants. The e2e tests
    // (in reference_fns_e2e.rs) exercise the full binder→dispatcher→
    // lazy-materializer chain via real `ISREF(A1)` strings.

    #[test]
    fn isref_of_cellref_shape_is_true() {
        let ctx = ctx_no_cell();
        assert_eq!(
            isref(&[RefArg::Shape(PlanKind::CellRef)], &ctx),
            Value::Boolean(true)
        );
    }

    #[test]
    fn isref_of_rangeref_shape_is_true() {
        let ctx = ctx_no_cell();
        assert_eq!(
            isref(&[RefArg::Shape(PlanKind::RangeRef)], &ctx),
            Value::Boolean(true)
        );
    }

    #[test]
    fn isref_of_function_call_shape_is_false_when_not_reference_returning() {
        let ctx = ctx_no_cell();
        // v1: SUM etc. — Function { returns_reference: false } → FALSE.
        assert_eq!(
            isref(
                &[RefArg::Shape(PlanKind::Function {
                    returns_reference: false
                })],
                &ctx
            ),
            Value::Boolean(false)
        );
    }

    #[test]
    fn isref_of_function_call_shape_is_true_when_reference_returning() {
        let ctx = ctx_no_cell();
        // Future case: when OFFSET / INDIRECT ship as reference-returning
        // fns, the dispatcher will emit `returns_reference: true`.
        // ISREF must return TRUE for that shape. v1 dispatcher hardcodes
        // `false`, so this test pins the future-correct path.
        assert_eq!(
            isref(
                &[RefArg::Shape(PlanKind::Function {
                    returns_reference: true
                })],
                &ctx
            ),
            Value::Boolean(true)
        );
    }

    #[test]
    fn isref_of_literal_shape_is_false() {
        let ctx = ctx_no_cell();
        // Number / Bool / String / Array / Binary / Unary all collapse
        // to PlanKind::Literal per the dispatcher's lazy materializer.
        assert_eq!(
            isref(&[RefArg::Shape(PlanKind::Literal)], &ctx),
            Value::Boolean(false)
        );
    }

    #[test]
    fn isref_of_error_shape_is_false() {
        let ctx = ctx_no_cell();
        // `#REF!` literal → PlanKind::Error → FALSE.
        assert_eq!(
            isref(&[RefArg::Shape(PlanKind::Error)], &ctx),
            Value::Boolean(false)
        );
    }

    #[test]
    fn isref_arity_zero_returns_na() {
        let ctx = ctx_no_cell();
        assert_eq!(isref(&[], &ctx), Value::Error(ErrorValue::NA));
    }

    #[test]
    fn isref_arity_two_returns_na() {
        let ctx = ctx_no_cell();
        assert_eq!(
            isref(
                &[
                    RefArg::Shape(PlanKind::CellRef),
                    RefArg::Shape(PlanKind::CellRef)
                ],
                &ctx
            ),
            Value::Error(ErrorValue::NA)
        );
    }

    // Defense-in-depth: ISREF with Eager-materialized args (unreachable
    // via the LazyShape contract, but pinned for impl robustness).

    #[test]
    fn isref_with_reference_eager_arg_returns_true_defensive() {
        let ctx = ctx_no_cell();
        // Eager-contract path is unreachable via LazyShape; defensive arm.
        assert_eq!(isref(&[cell_ref(0, 0, 0)], &ctx), Value::Boolean(true));
    }

    #[test]
    fn isref_with_scalar_eager_arg_returns_false_defensive() {
        let ctx = ctx_no_cell();
        assert_eq!(
            isref(&[RefArg::Scalar(Value::number(42.0))], &ctx),
            Value::Boolean(false)
        );
    }

    // ===== ISFORMULA =====
    //
    // ISFORMULA uses ArgContract::Eager — the dispatcher emits Reference
    // / Range / Array / Scalar / Error per the materializer. Unit tests
    // construct each shape directly. The e2e tests exercise the full
    // chain with a real workbook backing.
    //
    // Note: the unit tests use NoOpReferenceQuery (via ctx_no_cell), so
    // `ctx.workbook.is_formula_at` always returns false. To test the
    // TRUE-when-formula path, use the e2e file with a real WorkbookEnv.

    #[test]
    fn isformula_of_cellref_with_noop_workbook_returns_false() {
        let ctx = ctx_no_cell();
        // NoOpReferenceQuery → no formula at any address → FALSE.
        assert_eq!(isformula(&[cell_ref(0, 0, 0)], &ctx), Value::Boolean(false));
    }

    #[test]
    fn isformula_of_single_cell_range_with_noop_workbook_returns_false() {
        let ctx = ctx_no_cell();
        // 1×1 range — treated as single-cell. NoOp → FALSE.
        assert_eq!(
            isformula(&[range_ref(0, 5, 5, 5, 5)], &ctx),
            Value::Boolean(false)
        );
    }

    #[test]
    fn isformula_of_multi_cell_range_returns_na() {
        let ctx = ctx_no_cell();
        // Microsoft canon: multi-cell → #N/A.
        assert_eq!(
            isformula(&[range_ref(0, 0, 0, 2, 1)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn isformula_of_text_scalar_returns_na() {
        let ctx = ctx_no_cell();
        // Microsoft canon (vs IronCalc's #VALUE!): non-reference → #N/A.
        assert_eq!(
            isformula(&[RefArg::Scalar(Value::Text("text".into()))], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn isformula_of_number_scalar_returns_na() {
        let ctx = ctx_no_cell();
        assert_eq!(
            isformula(&[RefArg::Scalar(Value::number(42.0))], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn isformula_of_array_literal_returns_na() {
        let ctx = ctx_no_cell();
        let av = ql_types::ArrayValue::new(2, 2, vec![Value::number(1.0); 4]).unwrap();
        assert_eq!(
            isformula(&[RefArg::Array(av)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn isformula_propagates_error_arg() {
        let ctx = ctx_no_cell();
        assert_eq!(
            isformula(&[RefArg::Error(ErrorValue::Ref)], &ctx),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn isformula_arity_zero_returns_na() {
        let ctx = ctx_no_cell();
        assert_eq!(isformula(&[], &ctx), Value::Error(ErrorValue::NA));
    }

    #[test]
    fn isformula_arity_two_returns_na() {
        let ctx = ctx_no_cell();
        assert_eq!(
            isformula(&[cell_ref(0, 0, 0), cell_ref(0, 0, 1)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    // ===== FORMULATEXT (W5-RT-4 Step 4) =====
    //
    // FORMULATEXT uses ArgContract::Eager + ReferenceQuery::formula_text_at.
    // Unit tests use NoOpReferenceQuery → always returns None → #N/A.
    // The e2e tests in `reference_fns_step4_e2e.rs` exercise the
    // formula-bearing happy paths via a real Workbook + put_formula.

    #[test]
    fn formulatext_of_cellref_with_noop_workbook_returns_na() {
        let ctx = ctx_no_cell();
        // NoOpReferenceQuery → no formula at any address → #N/A.
        assert_eq!(
            formulatext(&[cell_ref(0, 0, 0)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn formulatext_of_single_cell_range_with_noop_workbook_returns_na() {
        let ctx = ctx_no_cell();
        // 1×1 range — treated as single-cell. NoOp → #N/A.
        assert_eq!(
            formulatext(&[range_ref(0, 5, 5, 5, 5)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn formulatext_of_multi_cell_range_returns_na() {
        let ctx = ctx_no_cell();
        // Microsoft canon: multi-cell → #N/A.
        assert_eq!(
            formulatext(&[range_ref(0, 0, 0, 2, 1)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn formulatext_of_text_scalar_returns_na() {
        let ctx = ctx_no_cell();
        // Microsoft canon (vs IronCalc #ERROR!): non-reference → #N/A.
        assert_eq!(
            formulatext(&[RefArg::Scalar(Value::Text("text".into()))], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn formulatext_of_number_scalar_returns_na() {
        let ctx = ctx_no_cell();
        assert_eq!(
            formulatext(&[RefArg::Scalar(Value::number(42.0))], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn formulatext_of_array_literal_returns_na() {
        let ctx = ctx_no_cell();
        let av = ql_types::ArrayValue::new(2, 2, vec![Value::number(1.0); 4]).unwrap();
        assert_eq!(
            formulatext(&[RefArg::Array(av)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn formulatext_propagates_error_arg() {
        let ctx = ctx_no_cell();
        assert_eq!(
            formulatext(&[RefArg::Error(ErrorValue::Ref)], &ctx),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn formulatext_arity_zero_returns_na() {
        let ctx = ctx_no_cell();
        assert_eq!(formulatext(&[], &ctx), Value::Error(ErrorValue::NA));
    }

    #[test]
    fn formulatext_arity_two_returns_na() {
        let ctx = ctx_no_cell();
        assert_eq!(
            formulatext(&[cell_ref(0, 0, 0), cell_ref(0, 0, 1)], &ctx),
            Value::Error(ErrorValue::NA)
        );
    }
}
