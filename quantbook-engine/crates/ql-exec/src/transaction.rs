//! `WorkbookTransaction` — Phase 2A.2 batch-write API.
//!
//! Buffers a sequence of value + formula writes, then applies them atomically on
//! `commit`. The IDE's "paste a 10×10 block" operation goes through one
//! transaction instead of 100 individual `set_value` calls — one save-state
//! change, one entry in the Phase 2A.3 op log per transaction.
//!
//! ## Semantics
//!
//! - **Eager validation**: `put_formula` runs lex + parse + bind at call time, so
//!   syntactic + name-resolution errors surface before any workbook state changes.
//!   Eval is deferred to commit (no `RuntimeError` from `commit` itself).
//! - **Two-pass commit**:
//!     1. Apply every literal value write + persist every formula's text. No
//!        formula evaluation yet.
//!     2. Evaluate each buffered formula against the now-updated workbook and
//!        write its result to the cell.
//!
//!   This means a formula that references a literal-value cell written EARLIER
//!   IN THE SAME TRANSACTION sees the new value (paste-block semantics).
//! - **Intra-batch formula→formula dependencies**: formulas evaluate in op-insert
//!   order. A formula referencing another formula in the same batch may see a
//!   stale value (whichever was computed last wins). Phase 4 calcgraph
//!   integration adds topological scheduling.
//! - **Drop without commit** = no-op. Buffered ops are discarded; workbook is
//!   unchanged. Useful for the IDE's "ESC cancels paste" path.
//! - **Last-write-wins**: writing the same cell twice in one transaction keeps
//!   both ops in the list, and pass 2 applies them in order — so the final value
//!   matches the last `put_*` for that cell.

use std::collections::HashMap;
use std::sync::Arc;

use ql_formula_syntax::{lex, parse};
use ql_functions::FunctionRegistry;
use ql_storage::Workbook;
use ql_types::{ColId, RowId, SheetId, Value};

use crate::env::WorkbookEnv;
use crate::plan::{bind_with_names, ExprPlan};
use crate::scalar::eval_scalar_with_registry;
use crate::workbook_runtime::{validate_cell, RuntimeError};

/// Phase 2A.6 audit H4: track the *kind* of op last buffered for each cell so
/// `put_value` after `put_formula` (or vice versa) on the same cell can be
/// rejected loudly at buffer time. Same-kind multi-writes (two `put_value`s,
/// two `put_formula`s) are still allowed — the existing last-write-wins
/// semantics handle them cleanly.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum OpKind {
    Value,
    Formula,
}

/// One pending operation in a transaction. Internal — the public API is the
/// `put_value` / `put_formula` methods.
enum PendingOp {
    Value {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: Value,
    },
    Formula {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        text: Arc<str>,
        plan: ExprPlan,
    },
}

/// Batch writer for the workbook. Construct with `WorkbookTransaction::new` (or
/// via `WorkbookRuntime::transaction`), buffer writes via `put_value` and
/// `put_formula`, then call `commit` to apply them all.
///
/// The transaction holds a `&mut Workbook` for its entire lifetime — only one
/// transaction can exist per workbook at a time (enforced by the borrow checker).
pub struct WorkbookTransaction<'a> {
    workbook: &'a mut Workbook,
    registry: &'a FunctionRegistry,
    ops: Vec<PendingOp>,
    /// Phase 2A.6 audit H4: per-cell last-buffered op kind. Used to reject
    /// mixed-kind writes (value+formula on the same cell within one tx) at
    /// buffer time so the resulting workbook state is unambiguous.
    cell_kinds: HashMap<(SheetId, RowId, ColId), OpKind>,
}

impl<'a> WorkbookTransaction<'a> {
    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
        Self {
            workbook,
            registry,
            ops: Vec::new(),
            cell_kinds: HashMap::new(),
        }
    }

    /// Buffer a literal value write. The write isn't visible to the workbook
    /// (or to other transactions) until `commit`. Any existing formula at the
    /// cell is cleared at commit (typing a value over a formula deletes it,
    /// per Excel canon).
    ///
    /// Phase 2A.6 audit H1: the destination `sheet` is validated up front so
    /// commit can't panic from `Workbook::put_at` mid-flight, leaving partial
    /// writes. Audit H4: rejects with `RuntimeError::ConflictingOps` if a
    /// formula was already buffered for the same cell in this transaction.
    pub fn put_value(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: Value,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        self.check_op_kind(sheet, row, col, OpKind::Value)?;
        self.ops.push(PendingOp::Value {
            sheet,
            row,
            col,
            value,
        });
        Ok(())
    }

    /// Buffer a formula write. The formula text is lexed + parsed + bound NOW
    /// (so syntactic + name-resolution errors surface before any state change),
    /// but evaluation is deferred to `commit` — meaning the formula sees writes
    /// from earlier ops in the same transaction.
    ///
    /// `formula_text` is the formula body without the leading `=`.
    ///
    /// Phase 2A.6 audit H1: validates `sheet` up front. Audit H4: rejects with
    /// `RuntimeError::ConflictingOps` if a value op was already buffered for
    /// the same cell in this transaction (mixing value+formula on one cell
    /// within a single batch was previously possible but produced surprising
    /// final state — see audit doc for the formula-text-cleared-but-formula-
    /// value-applied corner).
    ///
    /// Note on bound-plan staleness: bound plans capture the workbook's
    /// NameTable state at buffer time. Names registered between two
    /// transactions take effect for the next transaction's `put_formula` calls,
    /// but cannot be retroactively rebound (the transaction holds `&mut
    /// Workbook` for its lifetime, so the user can't mutate names mid-tx
    /// anyway).
    pub fn put_formula(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: impl Into<Arc<str>>,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        self.check_op_kind(sheet, row, col, OpKind::Formula)?;

        let text = formula_text.into();
        let tokens = lex(text.as_ref())?;
        let expr = parse(tokens)?;
        // Bind eagerly against the current workbook NameTable. The transaction
        // doesn't allow registering names mid-batch (the &mut Workbook borrow
        // prevents the user from mutating names while the tx is alive), so the
        // table is stable for the transaction's lifetime — eager binding is
        // safe and surfaces UnresolvedName / UnsupportedVariant before any
        // writes land.
        let plan = bind_with_names(&expr, sheet, self.workbook.names())?;
        self.ops.push(PendingOp::Formula {
            sheet,
            row,
            col,
            text,
            plan,
        });
        Ok(())
    }

    /// Phase 2A.6 audit H4 helper. Returns Err if a different op kind was
    /// already buffered for `(sheet,row,col)`; otherwise records `kind` and
    /// returns Ok. Same-kind multi-writes are allowed (last-write-wins).
    fn check_op_kind(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        kind: OpKind,
    ) -> Result<(), RuntimeError> {
        match self.cell_kinds.get(&(sheet, row, col)) {
            Some(prior) if *prior != kind => Err(RuntimeError::ConflictingOps { sheet, row, col }),
            _ => {
                self.cell_kinds.insert((sheet, row, col), kind);
                Ok(())
            }
        }
    }

    /// Number of buffered ops. Useful for the IDE to display "5 writes pending".
    pub fn op_count(&self) -> usize {
        self.ops.len()
    }

    /// Apply all buffered ops to the workbook. See module docs for the two-pass
    /// semantics. Consumes the transaction.
    pub fn commit(self) {
        let Self {
            workbook,
            registry,
            ops,
            cell_kinds: _,
        } = self;

        // Pass 1: apply literals + persist formula text. No formula eval yet.
        // Iterating by reference so we can move ops into pass 2.
        for op in &ops {
            match op {
                PendingOp::Value {
                    sheet,
                    row,
                    col,
                    value,
                } => {
                    workbook.put_at(*sheet, *row, *col, value.clone());
                    workbook.clear_formula(*sheet, *row, *col);
                }
                PendingOp::Formula {
                    sheet,
                    row,
                    col,
                    text,
                    ..
                } => {
                    workbook.put_formula(*sheet, *row, *col, Arc::clone(text));
                    // Cell's current value stays as-is until pass 2 overwrites it.
                }
            }
        }

        // Pass 2: evaluate each buffered formula against the post-write workbook
        // and write the result. The env borrow is scoped to drop before the
        // mutable put_at — same pattern as workbook_runtime.rs.
        for op in ops {
            if let PendingOp::Formula {
                sheet,
                row,
                col,
                plan,
                ..
            } = op
            {
                let value = {
                    let env = WorkbookEnv::new(workbook);
                    eval_scalar_with_registry(&plan, &env, registry)
                };
                workbook.put_at(sheet, row, col, value);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_functions::default_registry;
    use ql_storage::NamedTarget;
    use ql_types::{Address, ErrorValue};

    fn make_wb() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== put_value =====

    #[test]
    fn put_value_buffers_until_commit() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 0, 0, Value::Number(1.0)).unwrap();
        tx.put_value(0, 0, 1, Value::Number(2.0)).unwrap();
        tx.put_value(0, 0, 2, Value::Number(3.0)).unwrap();
        assert_eq!(tx.op_count(), 3);
        // Not yet visible.
        // (Can't read wb here — tx holds &mut. Drop tx first.)
        tx.commit();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(Address::new(0, 0, 2)), Value::Number(3.0));
    }

    #[test]
    fn dropping_transaction_without_commit_leaves_workbook_unchanged() {
        let mut wb = make_wb();
        let reg = default_registry();
        {
            let mut tx = WorkbookTransaction::new(&mut wb, &reg);
            tx.put_value(0, 0, 0, Value::Number(42.0)).unwrap();
            // Drop without commit.
        }
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
    }

    #[test]
    fn commit_with_no_ops_is_noop() {
        let mut wb = make_wb();
        let reg = default_registry();
        let tx = WorkbookTransaction::new(&mut wb, &reg);
        assert_eq!(tx.op_count(), 0);
        tx.commit();
        // Workbook still empty.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
    }

    // ===== put_formula =====

    #[test]
    fn put_formula_commits_text_and_value() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_formula(0, 0, 0, "1 + 2 * 3").unwrap();
        tx.commit();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(7.0));
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("1 + 2 * 3")
        );
    }

    #[test]
    fn formula_sees_value_written_in_same_transaction() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        // The classic paste-block scenario: A1 is a literal, B1 references A1.
        // At commit time, pass 1 writes A1=10; pass 2 evaluates B1=A1*2 against
        // the post-pass-1 workbook, seeing A1=10 → B1=20.
        tx.put_value(0, 0, 0, Value::Number(10.0)).unwrap();
        tx.put_formula(0, 0, 1, "A1 * 2").unwrap();
        tx.commit();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(10.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(20.0));
    }

    #[test]
    fn put_formula_parse_error_rejects_op_immediately() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        // Buffer a good op first.
        tx.put_value(0, 0, 0, Value::Number(99.0)).unwrap();

        // Now a parse error.
        let result = tx.put_formula(0, 0, 1, "(1 + 2");
        assert!(matches!(result, Err(RuntimeError::Parse(_))));
        // The failed op didn't land in the buffer.
        assert_eq!(tx.op_count(), 1);

        // Subsequent good ops still work.
        tx.put_value(0, 0, 2, Value::Number(77.0)).unwrap();
        tx.commit();

        // Good ops applied; failed op had no effect.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(99.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Blank);
        assert_eq!(wb.read(Address::new(0, 0, 2)), Value::Number(77.0));
    }

    #[test]
    fn put_formula_unresolved_name_errors_at_buffer_time() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        // No name registered → bind-time UnresolvedName surfaces here.
        let result = tx.put_formula(0, 0, 0, "UnknownName + 1");
        assert!(
            matches!(
                result,
                Err(RuntimeError::Bind(crate::plan::BindError::UnresolvedName(
                    _
                )))
            ),
            "expected Bind(UnresolvedName), got {result:?}"
        );
        assert_eq!(tx.op_count(), 0);
    }

    #[test]
    fn value_write_clears_existing_formula() {
        let mut wb = make_wb();
        let reg = default_registry();
        // Seed A1 with a formula.
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_formula(0, 0, 0, "1 + 4");
        assert!(wb.formula_at(0, 0, 0).is_some());

        // Transaction overwrites with a literal.
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 0, 0, Value::Number(100.0)).unwrap();
        tx.commit();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(100.0));
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    #[test]
    fn last_write_wins_when_same_cell_written_twice() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 0, 0, Value::Number(1.0)).unwrap();
        tx.put_value(0, 0, 0, Value::Number(2.0)).unwrap();
        tx.put_value(0, 0, 0, Value::Number(3.0)).unwrap();
        tx.commit();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(3.0));
    }

    /// Phase 2A.6 audit H4 (2026-05-12): mixing value + formula on the SAME cell
    /// within a single transaction was previously allowed and produced surprising
    /// final state (literal-then-formula left both consistent, but formula-then-
    /// literal left formula-value-with-cleared-formula-text). The fix rejects
    /// both orderings loudly with `ConflictingOps`.
    #[test]
    fn value_then_formula_on_same_cell_rejected_as_conflict() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        tx.put_value(0, 0, 0, Value::Number(99.0)).unwrap();
        let result = tx.put_formula(0, 0, 0, "10 + 5");
        match result {
            Err(RuntimeError::ConflictingOps { sheet, row, col }) => {
                assert_eq!((sheet, row, col), (0, 0, 0));
            }
            other => panic!("expected ConflictingOps, got {other:?}"),
        }
        // The first op stays buffered; the rejected op didn't.
        assert_eq!(tx.op_count(), 1);
        tx.commit();
        // Final state reflects only the literal.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(99.0));
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    #[test]
    fn formula_then_value_on_same_cell_rejected_as_conflict() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        tx.put_formula(0, 0, 0, "10 + 5").unwrap();
        let result = tx.put_value(0, 0, 0, Value::Number(99.0));
        match result {
            Err(RuntimeError::ConflictingOps { sheet, row, col }) => {
                assert_eq!((sheet, row, col), (0, 0, 0));
            }
            other => panic!("expected ConflictingOps, got {other:?}"),
        }
        assert_eq!(tx.op_count(), 1);
        tx.commit();
        // Final state reflects only the formula.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(15.0));
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("10 + 5"));
    }

    #[test]
    fn multiple_value_writes_on_same_cell_still_allowed_after_conflict_fix() {
        // Audit H4 introduces ConflictingOps for mixed-kind writes only. Same-kind
        // multi-writes (last-write-wins) must continue to work — pin it.
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 0, 0, Value::Number(1.0)).unwrap();
        tx.put_value(0, 0, 0, Value::Number(2.0)).unwrap();
        tx.put_formula(0, 1, 0, "A1 + 100").unwrap();
        tx.put_formula(0, 1, 0, "A1 + 200").unwrap(); // last-write-wins for formulas
        tx.commit();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(2.0));
        assert_eq!(wb.read(Address::new(0, 1, 0)), Value::Number(202.0));
        assert_eq!(wb.formula_at(0, 1, 0).map(|s| s.as_ref()), Some("A1 + 200"));
    }

    #[test]
    fn named_constant_resolves_inside_transaction() {
        let mut wb = make_wb();
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_formula(0, 0, 0, "1000 * TaxRate").unwrap();
        tx.commit();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(210.0));
    }

    #[test]
    fn formula_error_value_propagates_through_commit() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        // 10/0 is a valid formula that evaluates to #DIV/0!. Commit applies it
        // without error — the error lives in the cell as a Value, not in the
        // commit return.
        tx.put_formula(0, 0, 0, "10 / 0").unwrap();
        tx.commit();

        assert_eq!(
            wb.read(Address::new(0, 0, 0)),
            Value::Error(ErrorValue::DivZero)
        );
        // Formula text still persisted even on error-valued result.
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("10 / 0"));
    }

    #[test]
    fn paste_block_pattern_5x2_grid() {
        // The motivating use case: paste a small grid in one transaction, then
        // a formula referencing the block. Phase 1's scalar eval doesn't accept
        // range args (`SUM(A1:B5)` requires aggregate dispatch — Phase 2B+), so
        // the formula here references each cell individually. The point is that
        // 11 ops commit atomically and the formula sees every literal.
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        for r in 0..5u32 {
            tx.put_value(0, r, 0, Value::Number((r + 1) as f64))
                .unwrap();
            tx.put_value(0, r, 1, Value::Number(((r + 1) * 10) as f64))
                .unwrap();
        }
        tx.put_formula(0, 5, 0, "SUM(A1, B1, A2, B2, A3, B3, A4, B4, A5, B5)")
            .unwrap();
        assert_eq!(tx.op_count(), 11);
        tx.commit();

        // Sum of 1,10, 2,20, 3,30, 4,40, 5,50 = 165.
        assert_eq!(wb.read(Address::new(0, 5, 0)), Value::Number(165.0));
    }

    // ===== Phase 2A.6 audit H1: sheet validation =====

    #[test]
    fn put_value_rejects_invalid_sheet() {
        let mut wb = make_wb(); // has one sheet (id 0)
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_value(99, 0, 0, Value::Number(1.0));
        match result {
            Err(RuntimeError::InvalidSheet { sheet, sheet_count }) => {
                assert_eq!(sheet, 99);
                assert_eq!(sheet_count, 1);
            }
            other => panic!("expected InvalidSheet, got {other:?}"),
        }
        assert_eq!(tx.op_count(), 0);
    }

    #[test]
    fn put_formula_rejects_invalid_sheet() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_formula(5, 0, 0, "1 + 1");
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
        assert_eq!(tx.op_count(), 0);
    }

    #[test]
    fn transaction_on_workbook_with_no_sheets_errors_at_buffer_time() {
        // Audit L5 regression guard: empty workbook (no sheets) used to panic at
        // commit time. Now: clean InvalidSheet error at buffer time.
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        let result = tx.put_value(0, 0, 0, Value::Number(1.0));
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidSheet {
                    sheet: 0,
                    sheet_count: 0
                })
            ),
            "expected InvalidSheet, got {result:?}"
        );
    }

    // ===== Phase 2A.7 audit H1: row/col validation =====

    #[test]
    fn put_value_rejects_row_above_max() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_value(0, 1_048_576, 0, Value::Number(1.0));
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidCell { row: 1_048_576, .. })
            ),
            "expected InvalidCell, got {result:?}"
        );
        assert_eq!(tx.op_count(), 0);
    }

    #[test]
    fn put_formula_rejects_col_above_max() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_formula(0, 0, 16_384, "1 + 1");
        assert!(
            matches!(result, Err(RuntimeError::InvalidCell { col: 16_384, .. })),
            "expected InvalidCell, got {result:?}"
        );
        assert_eq!(tx.op_count(), 0);
    }

    #[test]
    fn put_value_at_max_row_max_col_ok() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 1_048_575, 16_383, Value::Number(42.0))
            .unwrap();
        tx.commit();
        assert_eq!(
            wb.read(Address::new(0, 1_048_575, 16_383)),
            Value::Number(42.0)
        );
    }

    // ===== Phase 2A.6 audit M2/M3: Blank/Error named-target rejection =====

    #[test]
    fn named_blank_constant_surfaces_as_distinct_bind_error() {
        use crate::plan::BindError;
        let mut wb = make_wb();
        wb.set_name("MyBlank", NamedTarget::Constant(Value::Blank))
            .unwrap();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_formula(0, 0, 0, "MyBlank + 1");
        match result {
            Err(RuntimeError::Bind(BindError::NamedTargetIsBlank(name))) => {
                // Parser canonicalizes to upper case.
                assert_eq!(name.as_ref(), "MYBLANK");
            }
            other => panic!("expected Bind(NamedTargetIsBlank), got {other:?}"),
        }
    }

    #[test]
    fn named_error_constant_surfaces_as_distinct_bind_error() {
        use crate::plan::BindError;
        let mut wb = make_wb();
        wb.set_name(
            "MyErr",
            NamedTarget::Constant(Value::Error(ErrorValue::DivZero)),
        )
        .unwrap();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_formula(0, 0, 0, "MyErr + 1");
        match result {
            Err(RuntimeError::Bind(BindError::NamedTargetIsError(name, err))) => {
                assert_eq!(name.as_ref(), "MYERR");
                assert_eq!(err, ErrorValue::DivZero);
            }
            other => panic!("expected Bind(NamedTargetIsError), got {other:?}"),
        }
    }

    // ===== runtime → transaction integration =====

    #[test]
    fn runtime_transaction_method_returns_working_tx() {
        use crate::WorkbookRuntime;
        let mut wb = make_wb();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let mut tx = rt.transaction();
        tx.put_value(0, 0, 0, Value::Number(7.0)).unwrap();
        tx.put_formula(0, 0, 1, "A1 * 2").unwrap();
        tx.commit();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(7.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(14.0));
    }

    /// Phase 2A.12 audit L6: 10k-op stress test for the paste-block use case.
    /// Asserts the buffer + commit can absorb a 10000-cell transaction in
    /// under 5 seconds on debug builds (release is much faster). Memory
    /// footprint isn't measured here (would need a custom allocator hook);
    /// the perf floor is the practical user-experience bound.
    #[test]
    fn stress_10k_op_paste_block_completes_under_5s_debug() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let start = std::time::Instant::now();
        // 100 × 100 grid = 10_000 literal writes.
        for r in 0..100u32 {
            for c in 0..100u32 {
                tx.put_value(0, r, c, Value::Number((r * 100 + c) as f64))
                    .unwrap();
            }
        }
        assert_eq!(tx.op_count(), 10_000);
        tx.commit();
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_secs_f64() < 5.0,
            "10k-op stress took {elapsed:?}; perf-floor is 5s on debug"
        );

        // Spot-check a few cells to confirm the data landed.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(0.0));
        assert_eq!(wb.read(Address::new(0, 50, 50)), Value::Number(5050.0));
        assert_eq!(wb.read(Address::new(0, 99, 99)), Value::Number(9999.0));
    }
}
