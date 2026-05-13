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

    /// `FormatTable::register_at` refused the registration — the id is
    /// already taken with a different string, or the string is already
    /// at a different id. **W5-80 (Phase 4.5.D part 4).**
    #[error("replay format rejected at op index {index}: {source:?}")]
    FormatRejected {
        index: usize,
        #[source]
        source: FormatRejectedSource,
    },

    /// `Op::SetCellFormat` referenced a format id that hasn't been
    /// registered yet. The producer SHOULD always emit `RegisterFormat`
    /// BEFORE `SetCellFormat` for any custom id; replay enforces that.
    /// **W5-80.**
    #[error("replay set-cell-format references unregistered format id {id} at op index {index}")]
    FormatNotRegistered { index: usize, id: u32 },
}

/// Wrapper around `ql_storage::FormatTableError` that owns its strings,
/// so `ReplayError` can stay `Clone + std::error::Error` without
/// borrowing into the table.
#[derive(Clone, Debug, thiserror::Error)]
pub enum FormatRejectedSource {
    #[error("format id {id} already bound to {existing:?}, can't re-bind to {attempted:?}")]
    IdCollision {
        id: u32,
        existing: String,
        attempted: String,
    },
    #[error(
        "format string {string:?} already at id {existing_id}, can't bind to id {attempted_id}"
    )]
    StringCollision {
        string: String,
        existing_id: u32,
        attempted_id: u32,
    },
}

impl From<ql_storage::FormatTableError> for FormatRejectedSource {
    fn from(e: ql_storage::FormatTableError) -> Self {
        match e {
            ql_storage::FormatTableError::IdCollision {
                id,
                existing,
                attempted,
            } => FormatRejectedSource::IdCollision {
                id: id.0,
                existing,
                attempted,
            },
            ql_storage::FormatTableError::StringCollision {
                string,
                existing_id,
                attempted_id,
            } => FormatRejectedSource::StringCollision {
                string,
                existing_id: existing_id.0,
                attempted_id: attempted_id.0,
            },
        }
    }
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
        Op::RegisterFormat { id, string } => {
            // **W5-80:** route through `FormatTable::register_at` so
            // collisions surface as `FormatRejected` (rather than the
            // panic-on-duplicate behavior `intern` would have via the
            // by_string fast path; `register_at` is the explicit-id form).
            let fid = ql_storage::FormatId(*id);
            workbook
                .formats_mut()
                .register_at(fid, string.as_str())
                .map_err(|e| ReplayError::FormatRejected {
                    index,
                    source: e.into(),
                })?;
            Ok(())
        }
        Op::SetCellFormat {
            sheet,
            row,
            col,
            id,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            // **W5-80:** require the id to be registered. Catches
            // producer bugs where `SetCellFormat` was emitted without
            // a preceding `RegisterFormat`. `None` means clear.
            if let Some(raw_id) = id {
                let fid = ql_storage::FormatId(*raw_id);
                if workbook.formats().lookup(fid).is_none() {
                    return Err(ReplayError::FormatNotRegistered { index, id: *raw_id });
                }
                workbook
                    .sheet_mut(*sheet)
                    .expect("sheet validated above")
                    .format_overlay_mut()
                    .set(*row, *col, fid);
            } else {
                workbook
                    .sheet_mut(*sheet)
                    .expect("sheet validated above")
                    .format_overlay_mut()
                    .clear(*row, *col);
            }
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

    // ===== W5-80 / Phase 4.5.D part 4 — format op tests =====

    #[test]
    fn replay_register_format_installs_custom_id() {
        let mut log = OpLog::new();
        log.append(Op::RegisterFormat {
            id: 200,
            string: "\"€\" #,##0.00".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(
            wb.formats().lookup(ql_storage::FormatId(200)),
            Some("\"€\" #,##0.00")
        );
    }

    #[test]
    fn replay_register_format_idempotent_for_existing_builtin() {
        // Re-registering an Excel built-in at its canonical id is a no-op
        // (pre-populated by Workbook::default). Replay must not error.
        let mut log = OpLog::new();
        log.append(Op::RegisterFormat {
            id: 0,
            string: "General".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(
            wb.formats().lookup(ql_storage::FormatId(0)),
            Some("General")
        );
    }

    #[test]
    fn replay_register_format_id_collision_errors() {
        // Built-in id 0 is "General"; registering a DIFFERENT string at
        // id 0 must surface as `FormatRejected`.
        let mut log = OpLog::new();
        log.append(Op::RegisterFormat {
            id: 0,
            string: "WRONG".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::FormatRejected { index, source }) => {
                assert_eq!(index, 0);
                assert!(matches!(
                    source,
                    FormatRejectedSource::IdCollision { id: 0, .. }
                ));
            }
            other => panic!("expected FormatRejected, got {other:?}"),
        }
    }

    #[test]
    fn replay_set_cell_format_binds_overlay() {
        let mut log = OpLog::new();
        log.append(Op::RegisterFormat {
            id: 200,
            string: "0.000".to_owned(),
        })
        .unwrap();
        log.append(Op::SetCellFormat {
            sheet: 0,
            row: 3,
            col: 5,
            id: Some(200),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(
            wb.sheet(0).unwrap().format_overlay().get(3, 5),
            Some(ql_storage::FormatId(200))
        );
    }

    #[test]
    fn replay_set_cell_format_with_none_clears_overlay() {
        let mut log = OpLog::new();
        log.append(Op::RegisterFormat {
            id: 200,
            string: "0.000".to_owned(),
        })
        .unwrap();
        log.append(Op::SetCellFormat {
            sheet: 0,
            row: 3,
            col: 5,
            id: Some(200),
        })
        .unwrap();
        // Now clear via id=None.
        log.append(Op::SetCellFormat {
            sheet: 0,
            row: 3,
            col: 5,
            id: None,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet(0).unwrap().format_overlay().get(3, 5), None);
    }

    #[test]
    fn replay_set_cell_format_unregistered_id_errors() {
        // Op references id 999 but no RegisterFormat preceded it.
        let mut log = OpLog::new();
        log.append(Op::SetCellFormat {
            sheet: 0,
            row: 0,
            col: 0,
            id: Some(999),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::FormatNotRegistered { index, id }) => {
                assert_eq!(index, 0);
                assert_eq!(id, 999);
            }
            other => panic!("expected FormatNotRegistered, got {other:?}"),
        }
    }

    #[test]
    fn replay_set_cell_format_invalid_sheet_errors() {
        let mut log = OpLog::new();
        log.append(Op::SetCellFormat {
            sheet: 99,
            row: 0,
            col: 0,
            id: Some(0),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::InvalidSheet { sheet, .. }) => assert_eq!(sheet, 99),
            other => panic!("expected InvalidSheet, got {other:?}"),
        }
    }

    #[test]
    fn replay_register_and_set_cell_format_built_in_id_14() {
        // Common path: cells using a built-in m/d/yyyy format don't need
        // an explicit RegisterFormat (id 14 is pre-populated). Just
        // SetCellFormat should succeed.
        let mut log = OpLog::new();
        log.append(Op::SetCellFormat {
            sheet: 0,
            row: 0,
            col: 0,
            id: Some(14),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(
            wb.sheet(0).unwrap().format_overlay().get(0, 0),
            Some(ql_storage::FormatId(14))
        );
    }
}
