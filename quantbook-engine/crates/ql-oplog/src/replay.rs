//! Replay an `OpLog` against a `Workbook`.
//!
//! Phase 2A.3.a (2026-05-12): single entry point `replay_into(&OpLog, &mut
//! Workbook, &FunctionRegistry) -> Result<usize, ReplayError>`. Returns the
//! count of ops successfully applied; on failure, returns
//! `ReplayError::At { index, kind }` carrying the position of the failing
//! op and the underlying failure. The workbook is left in a partial state
//! on failure (callers decide whether to discard, recover, or recompute).
//!
//! ## Replay semantics
//!
//! Each `Op` variant maps to one `Workbook` mutation:
//!
//! - `PutValue` → `Workbook::put_at` (after row/col bounds check).
//! - `PutFormula` → `Workbook::put_formula` (text only; replay does NOT
//!   re-evaluate — that's a separate step the caller drives via
//!   `WorkbookRuntime::recompute_all`).
//! - `ClearFormula` → `Workbook::clear_formula`.
//! - `SetName` → `Workbook::set_name`. Reserved names (e.g. `AI`) surface
//!   as `ReplayError::NameRejected`.
//! - `AddSheet` → `Workbook::add_sheet_with_chunk_rows`.
//! - `BatchCommit` → recurse on each inner op. Index reporting flattens:
//!   a failure inside a BatchCommit reports the inner op's overall
//!   position (current outer index + offset).
//!
//! ## Idempotence
//!
//! `replay_into` is idempotent only in the trivial sense: replaying twice
//! against the same starting workbook produces the same final state IFF
//! the underlying mutation methods are themselves idempotent (and they
//! are — `put_at` / `put_formula` / `clear_formula` / `set_name` /
//! `add_sheet` all are). Callers wanting at-most-once semantics across
//! sessions track replay state themselves (Phase 5+ work).
//!
//! ## `registry` parameter
//!
//! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
//! 2A.3.a's replay doesn't use it (formula evaluation is deferred to a
//! separate `recompute_all` call), but keeping the parameter stable here
//! avoids a breaking signature change in 2A.3.b/c when the eval path
//! could land inside replay.

use ql_functions::FunctionRegistry;
use ql_storage::Workbook;
use ql_types::{ColId, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
use thiserror::Error;

use crate::log::OpLog;
use crate::op::Op;

/// Errors emitted by `replay_into`.
#[derive(Debug, Error)]
pub enum ReplayError {
    /// An op-log entry failed to deserialize (corrupted log data).
    #[error("replay deserialize error at op index {0}: {1}")]
    Deserialize(usize, #[source] crate::error::OpLogError),

    /// The op referenced an out-of-range sheet id.
    #[error(
        "replay invalid sheet at op index {index}: sheet {sheet} (workbook has {sheet_count})"
    )]
    InvalidSheet {
        index: usize,
        sheet: SheetId,
        sheet_count: usize,
    },

    /// The op carried out-of-range row/col coordinates.
    #[error("replay invalid cell at op index {index}: row={row} col={col} ({why})")]
    InvalidCell {
        index: usize,
        row: RowId,
        col: ColId,
        why: &'static str,
    },

    /// Decoding the on-wire `CellWireValue` failed (e.g., unknown error sigil).
    #[error("replay value-decode error at op index {index}: {source}")]
    ValueDecode {
        index: usize,
        #[source]
        source: ql_io::QbookError,
    },

    /// Decoding the on-wire `NamedTargetWire` failed.
    #[error("replay named-target decode error at op index {index}: {source}")]
    NamedTargetDecode {
        index: usize,
        #[source]
        source: ql_io::QbookError,
    },

    /// `Workbook::set_name` refused the name (reserved per CORR-06).
    #[error("replay name rejected at op index {index}: {name:?} ({source})")]
    NameRejected {
        index: usize,
        name: String,
        #[source]
        source: ql_storage::NameTableError,
    },
}

/// Replay every op in `log` against `workbook` in append order.
///
/// Returns the total count of ops applied on success. On failure, the
/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
/// the caller how far replay got.
///
/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
/// and is unused in 2A.3.a (replay persists formula text without
/// re-evaluating; callers drive evaluation through `recompute_all`).
pub fn replay_into(
    log: &OpLog,
    workbook: &mut Workbook,
    _registry: &FunctionRegistry,
) -> Result<usize, ReplayError> {
    let mut count = 0;
    for (index, op_result) in log.iter().enumerate() {
        let op = op_result.map_err(|e| ReplayError::Deserialize(index, e))?;
        apply_op(&op, workbook, index)?;
        count += 1;
    }
    Ok(count)
}

/// Recursive helper. `index` is the op's position in the outer log (or
/// the synthetic position of the enclosing BatchCommit for nested ops —
/// 2A.3.a flattens by reporting the parent's index for nested failures).
fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), ReplayError> {
    match op {
        Op::PutValue {
            sheet,
            row,
            col,
            value,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            let v: Value = value
                .to_value()
                .map_err(|source| ReplayError::ValueDecode { index, source })?;
            workbook.put_at(*sheet, *row, *col, v);
            Ok(())
        }
        Op::PutFormula {
            sheet,
            row,
            col,
            text,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            workbook.put_formula(*sheet, *row, *col, text.as_str());
            Ok(())
        }
        Op::ClearFormula { sheet, row, col } => {
            // clear_formula is idempotent on missing entries; we still
            // validate bounds so a corrupted op-log can't sneak past.
            validate_cell(workbook, *sheet, *row, *col, index)?;
            workbook.clear_formula(*sheet, *row, *col);
            Ok(())
        }
        Op::SetName { name, target } => {
            let target = target
                .to_target(name)
                .map_err(|source| ReplayError::NamedTargetDecode { index, source })?;
            workbook
                .set_name(name, target)
                .map_err(|source| ReplayError::NameRejected {
                    index,
                    name: name.clone(),
                    source,
                })?;
            Ok(())
        }
        Op::AddSheet { name, chunk_rows } => {
            // add_sheet panics on SheetId::MAX. Bound check would require
            // running through a try_add_sheet API which doesn't exist
            // (Phase 2A.6 audit M1 deferred it). For replay, we trust the
            // log: a workbook that successfully produced this op originally
            // had room for the sheet.
            workbook.add_sheet_with_chunk_rows(name.clone(), *chunk_rows);
            Ok(())
        }
        Op::BatchCommit { ops } => {
            for inner_op in ops {
                // Phase 2A.3.a: nested ops flatten to the parent's index
                // for error reporting. Phase 5+ may extend with
                // (outer, inner) tuple indexing once the producer side
                // emits nested commits in practice.
                apply_op(inner_op, workbook, index)?;
            }
            Ok(())
        }
    }
}

fn validate_cell(
    workbook: &Workbook,
    sheet: SheetId,
    row: RowId,
    col: ColId,
    index: usize,
) -> Result<(), ReplayError> {
    let count = workbook.sheet_count();
    if (sheet as usize) >= count {
        return Err(ReplayError::InvalidSheet {
            index,
            sheet,
            sheet_count: count,
        });
    }
    if row > MAX_ROW {
        return Err(ReplayError::InvalidCell {
            index,
            row,
            col,
            why: "row exceeds MAX_ROW (1,048,575)",
        });
    }
    if col > MAX_COLUMN {
        return Err(ReplayError::InvalidCell {
            index,
            row,
            col,
            why: "col exceeds MAX_COLUMN (16,383)",
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_functions::default_registry;
    use ql_io::{CellWireValue, NamedTargetWire};
    use ql_storage::NamedTarget;
    use ql_types::Address;

    fn fresh_workbook_with_one_sheet() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    #[test]
    fn replay_empty_log_succeeds() {
        let log = OpLog::new();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let n = replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn replay_put_value_lands_in_workbook() {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 5,
            col: 3,
            value: CellWireValue::Number(42.0),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let n = replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(n, 1);
        assert_eq!(wb.read(Address::new(0, 5, 3)), Value::Number(42.0));
    }

    #[test]
    fn replay_put_formula_persists_text_only() {
        let mut log = OpLog::new();
        log.append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "A1 + 1".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        // Formula text persisted ...
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("A1 + 1"));
        // ... value NOT evaluated (replay leaves recompute to the caller).
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
    }

    #[test]
    fn replay_clear_formula_idempotent() {
        let mut log = OpLog::new();
        log.append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "A1 + 1".to_owned(),
        })
        .unwrap();
        log.append(Op::ClearFormula {
            sheet: 0,
            row: 0,
            col: 0,
        })
        .unwrap();
        // Second ClearFormula on the now-empty cell — still ok.
        log.append(Op::ClearFormula {
            sheet: 0,
            row: 0,
            col: 0,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    #[test]
    fn replay_set_name_registers_target() {
        let mut log = OpLog::new();
        log.append(Op::SetName {
            name: "TaxRate".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.21),
            },
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(matches!(
            wb.names().lookup_ci("TaxRate"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
    }

    #[test]
    fn replay_add_sheet_grows_workbook() {
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Inventory".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet_count(), 2);
        assert_eq!(wb.sheet(1).unwrap().name(), "Inventory");
    }

    #[test]
    fn replay_batch_commit_applies_inner_ops_in_order() {
        let mut log = OpLog::new();
        log.append(Op::BatchCommit {
            ops: vec![
                Op::PutValue {
                    sheet: 0,
                    row: 0,
                    col: 0,
                    value: CellWireValue::Number(7.0),
                },
                Op::PutFormula {
                    sheet: 0,
                    row: 0,
                    col: 1,
                    text: "A1 * 2".to_owned(),
                },
            ],
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(7.0));
        assert_eq!(wb.formula_at(0, 0, 1).map(|s| s.as_ref()), Some("A1 * 2"));
    }

    #[test]
    fn replay_invalid_sheet_returns_indexed_error() {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(1.0),
        })
        .unwrap();
        // Op index 1: out-of-range sheet 5.
        log.append(Op::PutValue {
            sheet: 5,
            row: 0,
            col: 0,
            value: CellWireValue::Number(2.0),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let result = replay_into(&log, &mut wb, &reg);
        match result {
            Err(ReplayError::InvalidSheet {
                index,
                sheet,
                sheet_count,
            }) => {
                assert_eq!(index, 1);
                assert_eq!(sheet, 5);
                assert_eq!(sheet_count, 1);
            }
            other => panic!("expected InvalidSheet, got {other:?}"),
        }
        // Op 0 DID land (partial-state semantics).
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
    }

    #[test]
    fn replay_invalid_cell_row_above_max_returns_indexed_error() {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 1_048_576,
            col: 0,
            value: CellWireValue::Number(1.0),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let result = replay_into(&log, &mut wb, &reg);
        assert!(
            matches!(
                result,
                Err(ReplayError::InvalidCell {
                    index: 0,
                    row: 1_048_576,
                    ..
                })
            ),
            "expected InvalidCell, got {result:?}"
        );
    }

    #[test]
    fn replay_reserved_name_returns_name_rejected() {
        let mut log = OpLog::new();
        log.append(Op::SetName {
            name: "AI".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(42.0),
            },
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let result = replay_into(&log, &mut wb, &reg);
        match result {
            Err(ReplayError::NameRejected {
                index,
                name,
                source: _,
            }) => {
                assert_eq!(index, 0);
                assert_eq!(name, "AI");
            }
            other => panic!("expected NameRejected, got {other:?}"),
        }
    }
}
