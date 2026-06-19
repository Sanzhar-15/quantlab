//! Row-VISIBILITY API for `WorkbookRuntime` (Wave G2, engine-filter).
//!
//! One producer-side method, [`WorkbookRuntime::set_rows_hidden`], hides or
//! shows a set of rows on a sheet. It mirrors the append-before-mutate ordering
//! of [`super::styles`]'s `set_cell_style` and additionally dirties the cells in
//! the affected rows so `SUBTOTAL(101..=111)` dependents recompute against the
//! new visibility.
//!
//! There is no calc-graph "visibility" dependency edge: a hidden row is not a
//! cell write. But `SUBTOTAL` depends on the CELLS in its range, so firing the
//! value hook for each changed row's cells dirties exactly those dependents and
//! the existing range-stripe propagation does the rest. The cell VALUES are
//! unchanged, so the re-eval is a no-op for every formula EXCEPT the
//! visibility-sensitive `SUBTOTAL(101..=111)` — which is the point.

use ql_oplog::Op;
use ql_types::{RowId, SheetId};

use super::{validate_cell, validate_sheet, RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    /// **Wave G2 (engine-filter):** hide (`hidden = true`) or show
    /// (`hidden = false`) the given `rows` on `sheet`. Emits ONE
    /// `Op::SetRowsHidden` carrying only the rows whose state actually FLIPS
    /// (mirrors `set_cell_style`'s no-op collapse, so the op log + undo stack
    /// record real work only). Every row is validated BEFORE any mutation, so a
    /// bad row aborts the whole call atomically (No-Fallbacks — never a partial
    /// hidden set). After the mutation, the cells in each changed row (within the
    /// used column extent) are marked dirty so `SUBTOTAL(101..=111)` cells that
    /// reference them recompute.
    ///
    /// Returns the rows whose visibility actually changed (empty ⇒ a pure
    /// no-op), so the session can record exactly those for the snapshot delta.
    pub fn set_rows_hidden(
        &mut self,
        sheet: SheetId,
        rows: &[RowId],
        hidden: bool,
    ) -> Result<Vec<RowId>, RuntimeError> {
        validate_sheet(self.workbook, sheet)?;
        // Reuse the cell validator (col 0) for the `row <= MAX_ROW` bound; this
        // validates EVERY row up-front so the apply below is all-or-nothing.
        for &row in rows {
            validate_cell(self.workbook, sheet, row, 0)?;
        }
        // Collapse to the rows whose visibility actually changes — the op log
        // and the dirty pass then record real work only (mirrors set_cell_style).
        let changed: Vec<RowId> = {
            let s = self
                .workbook
                .sheet(sheet)
                .expect("validate_sheet guards bounds");
            rows.iter()
                .copied()
                .filter(|&r| s.is_row_hidden(r) != hidden)
                .collect()
        };
        if changed.is_empty() {
            return Ok(Vec::new());
        }
        // Append BEFORE mutate: a failing append leaves the workbook unchanged.
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::SetRowsHidden {
                sheet,
                rows: changed.clone(),
                hidden,
            })?;
        }
        // Apply the visibility change. After append-success this cannot fail.
        {
            let s = self
                .workbook
                .sheet_mut(sheet)
                .expect("validate_sheet guards bounds");
            for &row in &changed {
                s.set_row_hidden(row, hidden);
            }
        }
        // Dirty SUBTOTAL(101..=111) dependents. Bounded by the used column
        // extent (not the full 16K-wide grid). No-op when the runtime carries no
        // calc graph (Phase 1 parity).
        let col_extent = self
            .workbook
            .sheet(sheet)
            .expect("validate_sheet guarantees the sheet index is valid")
            .bounds()
            .col_extent;
        if let Some(g) = self.graph.as_deref_mut() {
            for &row in &changed {
                for col in 0..col_extent {
                    g.on_set_value(sheet, row, col);
                }
            }
        }
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_oplog::{Op, OpLog};
    use ql_storage::Workbook;

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    #[test]
    fn set_rows_hidden_emits_op_and_updates_sheet() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            rt.set_rows_hidden(s, &[2, 4], true).unwrap();
        }
        let hidden: Vec<u32> = wb.sheet(s).unwrap().hidden_rows().iter().copied().collect();
        assert_eq!(hidden, vec![2, 4]);
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert!(ops
            .iter()
            .any(|o| matches!(o, Op::SetRowsHidden { hidden: true, .. })));
    }

    #[test]
    fn set_rows_hidden_no_op_when_state_unchanged_emits_no_op() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            rt.set_rows_hidden(s, &[2], true).unwrap();
            // Hiding an already-hidden row + showing an already-visible row are
            // both no-ops — neither should append a second op.
            rt.set_rows_hidden(s, &[2], true).unwrap();
            rt.set_rows_hidden(s, &[9], false).unwrap();
        }
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        let hide_ops = ops
            .iter()
            .filter(|o| matches!(o, Op::SetRowsHidden { .. }))
            .count();
        assert_eq!(hide_ops, 1, "only the state-changing call appends an op");
    }

    #[test]
    fn set_rows_hidden_show_clears_membership() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            rt.set_rows_hidden(s, &[2, 4], true).unwrap();
            rt.set_rows_hidden(s, &[2], false).unwrap();
        }
        let hidden: Vec<u32> = wb.sheet(s).unwrap().hidden_rows().iter().copied().collect();
        assert_eq!(hidden, vec![4]);
    }

    #[test]
    fn set_rows_hidden_invalid_sheet_errors() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
        let err = rt.set_rows_hidden(42, &[0], true).unwrap_err();
        assert!(matches!(err, RuntimeError::InvalidSheet { sheet: 42, .. }));
    }

    #[test]
    fn set_rows_hidden_row_past_max_errors_atomically() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        let result = {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            // 3 is valid but the second row is out of range → the whole call
            // aborts before ANY mutation.
            rt.set_rows_hidden(s, &[3, ql_types::address::MAX_ROW + 1], true)
        };
        assert!(matches!(result, Err(RuntimeError::InvalidCell { .. })));
        assert!(wb.sheet(s).unwrap().hidden_rows().is_empty());
    }
}
