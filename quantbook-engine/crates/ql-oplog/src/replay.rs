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

    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
    /// whose current name matches neither `old_name` nor `new_name`
    /// (i.e. the replay state has diverged from what the op recorded).
    /// Surfaces a clean error rather than silently renaming a different
    /// sheet.
    #[error(
        "replay rename-sheet name mismatch at op index {index}: sheet {id} \
         expected current name {expected:?}, found {found:?}"
    )]
    SheetRenameNameMismatch {
        index: usize,
        id: SheetId,
        expected: String,
        found: String,
    },

    /// **W5-91 (Phase 4.6.C):** `Workbook::rename_sheet` refused the
    /// new name (duplicate, reserved character, empty).
    #[error(
        "replay rename-sheet rejected at op index {index}: sheet {id} \
         from {old_name:?} to {new_name:?} ({source})"
    )]
    SheetRenameRejected {
        index: usize,
        id: SheetId,
        old_name: String,
        new_name: String,
        #[source]
        source: ql_storage::SheetNameError,
    },

    /// **W5-93 (Phase 4.6.E closure):** `Op::AddSheet` carried a name
    /// that fails `Workbook::validate_sheet_name` — empty, duplicate
    /// under canonical comparison, or an Excel-reserved character.
    /// Codex HIGH-1 closed: pre-W5-93 the replay path silently
    /// accepted any name, so an op log produced against a buggy
    /// storage path could let conflicting sheets enter replay state.
    #[error("replay add-sheet rejected at op index {index}: name {name:?} ({source})")]
    SheetNameRejected {
        index: usize,
        name: String,
        #[source]
        source: ql_storage::SheetNameError,
    },

    /// **W5-118 (Phase 4.8.H):** `CreateTable` op references invariants
    /// the producer should have validated. Catches snapshot-vs-replay
    /// divergence (e.g. snapshot already has the table; another producer
    /// raced).
    #[error("replay create-table rejected at op index {index}: {reason}")]
    TableCreateRejected {
        index: usize,
        name: String,
        reason: &'static str,
    },

    /// **W5-118 (Phase 4.8.H):** `DropTable` op references a missing
    /// table. Surfaces snapshot-vs-replay divergence loudly per
    /// no-fallbacks doctrine.
    #[error("replay drop-table at op index {index}: table {name:?} not found")]
    TableNotFound { index: usize, name: String },
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
        Op::SetName {
            scope,
            name,
            target,
        } => {
            let target = target
                .to_target(name)
                .map_err(|source| ReplayError::NamedTargetDecode { index, source })?;
            match scope {
                None => {
                    // Workbook-scoped (historical path).
                    workbook.set_name(name, target).map_err(|source| {
                        ReplayError::NameRejected {
                            index,
                            name: name.clone(),
                            source,
                        }
                    })?;
                }
                Some(sheet) => {
                    // **W5-92 (Phase 4.6.D):** sheet-scoped. Validate sheet
                    // first so an unknown id surfaces as InvalidSheet, not
                    // a panicking out-of-bounds index.
                    let sheet_count = workbook.sheet_count();
                    let sheet_ref =
                        workbook
                            .sheet_mut(*sheet)
                            .ok_or(ReplayError::InvalidSheet {
                                index,
                                sheet: *sheet,
                                sheet_count,
                            })?;
                    sheet_ref.set_scoped_name(name, target).map_err(|source| {
                        ReplayError::NameRejected {
                            index,
                            name: name.clone(),
                            source,
                        }
                    })?;
                }
            }
            Ok(())
        }
        Op::AddSheet { name, chunk_rows } => {
            // **W5-93 (Phase 4.6.E closure):** route through the fallible
            // `try_add_sheet_with_chunk_rows` and surface a clean
            // `ReplayError::SheetNameRejected` on validation failure.
            // Codex HIGH-1 flagged that the prior infallible path
            // silently accepted duplicate-canonical names + reserved
            // characters at the replay boundary too.
            workbook
                .try_add_sheet_with_chunk_rows(name.clone(), *chunk_rows)
                .map_err(|source| ReplayError::SheetNameRejected {
                    index,
                    name: name.clone(),
                    source,
                })?;
            Ok(())
        }
        Op::RenameSheet {
            id,
            old_name,
            new_name,
        } => {
            // **W5-91 (Phase 4.6.C):** snapshot-vs-replay reconciliation
            // per design § 3.3. Three cases:
            //   1. Current sheet name == old_name → fresh rename; apply.
            //   2. Current sheet name == new_name → already-renamed (likely
            //      replay-on-top-of-snapshot where the snapshot captured
            //      the post-rename state). No-op; success.
            //   3. Current sheet name == neither → divergent state; treat as
            //      InvalidSheet for the op-log's safety contract.
            let current = workbook.sheet(*id).map(|s| s.name().to_owned()).ok_or(
                ReplayError::InvalidSheet {
                    index,
                    sheet: *id,
                    sheet_count: workbook.sheet_count(),
                },
            )?;
            let canonical = |s: &str| ql_storage::Workbook::canonical_sheet_name(s);
            let cur_c = canonical(&current);
            let old_c = canonical(old_name);
            let new_c = canonical(new_name);
            if cur_c == new_c {
                // Already renamed (snapshot-authoritative path). No-op.
                Ok(())
            } else if cur_c == old_c {
                workbook
                    .rename_sheet(*id, new_name.clone())
                    .map_err(|source| ReplayError::SheetRenameRejected {
                        index,
                        id: *id,
                        old_name: old_name.clone(),
                        new_name: new_name.clone(),
                        source,
                    })?;
                Ok(())
            } else {
                Err(ReplayError::SheetRenameNameMismatch {
                    index,
                    id: *id,
                    expected: old_name.clone(),
                    found: current,
                })
            }
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
        Op::CreateTable {
            name,
            sheet,
            top_row,
            top_col,
            rows,
            cols,
            has_header,
            has_totals,
            column_names,
        } => apply_create_table(
            workbook,
            index,
            name,
            *sheet,
            *top_row,
            *top_col,
            *rows,
            *cols,
            *has_header,
            *has_totals,
            column_names,
        ),
        Op::DropTable { name } => {
            let canonical = name.to_ascii_uppercase();
            if workbook
                .tables_mut()
                .remove(canonical.as_str())
                .is_none()
            {
                return Err(ReplayError::TableNotFound {
                    index,
                    name: name.clone(),
                });
            }
            Ok(())
        }
        Op::RenameTable { old_name, new_name } => {
            apply_rename_table(workbook, index, old_name, new_name)
        }
    }
}

/// **W5-119 (Phase 4.8.I):** replay a `RenameTable`. Validates source
/// exists, target name is available (TableTable + NameTable shared
/// namespace), then re-keys the entry. Note: formula text rewrites
/// arrive as accompanying `Op::PutFormula` ops; this arm doesn't
/// touch formula cells.
fn apply_rename_table(
    workbook: &mut Workbook,
    index: usize,
    old_name: &str,
    new_name: &str,
) -> Result<(), ReplayError> {
    let old_canonical = old_name.to_ascii_uppercase();
    let new_canonical: std::sync::Arc<str> =
        std::sync::Arc::from(new_name.to_ascii_uppercase().as_str());

    // Verify source.
    if workbook.tables().lookup(&old_canonical).is_none() {
        return Err(ReplayError::TableNotFound {
            index,
            name: old_name.to_owned(),
        });
    }
    // Verify target availability (skip the no-op same-name case).
    if !old_canonical.eq_ignore_ascii_case(new_name) {
        if workbook.tables().lookup(&new_canonical).is_some() {
            return Err(ReplayError::TableCreateRejected {
                index,
                name: new_name.to_owned(),
                reason: "table with this canonical name already exists (rename target)",
            });
        }
        if workbook.names().lookup_ci(&new_canonical).is_some() {
            return Err(ReplayError::TableCreateRejected {
                index,
                name: new_name.to_owned(),
                reason: "defined-name with this canonical name already exists (rename target)",
            });
        }
    }
    // Take the entry out, mutate name + display, reinsert under new key.
    let mut meta = workbook
        .tables_mut()
        .remove(&old_canonical)
        .expect("verified above");
    meta.name = std::sync::Arc::clone(&new_canonical);
    meta.display_name = std::sync::Arc::from(new_name);
    workbook.tables_mut().insert(new_canonical, meta);
    Ok(())
}

/// **W5-118 (Phase 4.8.H):** apply a `CreateTable` op against the
/// workbook. Validates the same invariants the producer side checks
/// (mirror via `WorkbookRuntime::create_table`).
#[allow(clippy::too_many_arguments)]
fn apply_create_table(
    workbook: &mut Workbook,
    index: usize,
    name: &str,
    sheet: SheetId,
    top_row: RowId,
    top_col: ColId,
    rows: u32,
    cols: u32,
    has_header: bool,
    has_totals: bool,
    column_names: &[String],
) -> Result<(), ReplayError> {
    use ql_storage::{TableColumn, TableMetadata};
    let canonical: std::sync::Arc<str> =
        std::sync::Arc::from(name.to_ascii_uppercase().as_str());
    if workbook.tables().lookup(&canonical).is_some() {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "table with this canonical name already exists",
        });
    }
    if workbook.names().lookup_ci(&canonical).is_some() {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "defined-name with this canonical name already exists (shared namespace)",
        });
    }
    if column_names.len() != cols as usize {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "column_names length does not match cols",
        });
    }
    if column_names.iter().any(|s| s.is_empty()) {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "table column names cannot be empty",
        });
    }
    // Column-name uniqueness (case-insensitive).
    {
        use std::collections::HashSet;
        let mut seen: HashSet<String> = HashSet::new();
        for cn in column_names {
            if !seen.insert(cn.to_ascii_lowercase()) {
                return Err(ReplayError::TableCreateRejected {
                    index,
                    name: name.to_owned(),
                    reason: "table column names must be unique (case-insensitive)",
                });
            }
        }
    }
    if workbook.sheet(sheet).is_none() {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "table references unknown sheet",
        });
    }
    if rows == 0 || cols == 0 {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "table rows and cols must both be > 0",
        });
    }
    // Non-overlap: check every cell in the footprint.
    for r in top_row..top_row + rows {
        for c in top_col..top_col + cols {
            if workbook.table_at(sheet, r, c).is_some() {
                return Err(ReplayError::TableCreateRejected {
                    index,
                    name: name.to_owned(),
                    reason: "table footprint overlaps an existing table",
                });
            }
        }
    }
    // Build columns with freshly-allocated ids.
    let columns: Vec<TableColumn> = column_names
        .iter()
        .map(|cn| TableColumn {
            id: workbook.tables_mut().allocate_column_id(),
            name: std::sync::Arc::from(cn.to_ascii_lowercase().as_str()),
            display: std::sync::Arc::from(cn.as_str()),
            totals_function: None,
        })
        .collect();
    let meta = TableMetadata {
        name: canonical.clone(),
        display_name: std::sync::Arc::from(name),
        sheet,
        top_row,
        top_col,
        rows,
        cols,
        has_header,
        has_totals,
        columns,
    };
    workbook.tables_mut().insert(canonical, meta);
    Ok(())
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
            scope: None,
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
            scope: None,
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

    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====

    #[test]
    fn replay_rename_sheet_basic() {
        // AddSheet + RenameSheet replays into a sheet with the new name.
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Sheet1".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::RenameSheet {
            id: 0,
            old_name: "Sheet1".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
    }

    #[test]
    fn replay_rename_sheet_already_renamed_is_noop() {
        // Replay-on-top-of-snapshot path: snapshot already has the new
        // name; replay must NOT error.
        let mut log = OpLog::new();
        log.append(Op::RenameSheet {
            id: 0,
            old_name: "Sheet1".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();

        let mut wb = Workbook::new();
        wb.add_sheet("Renamed"); // snapshot already at the new name
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
    }

    #[test]
    fn replay_rename_sheet_name_mismatch_errors() {
        // Snapshot has a name that's neither old nor new ⇒ divergent state.
        let mut log = OpLog::new();
        log.append(Op::RenameSheet {
            id: 0,
            old_name: "Sheet1".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();

        let mut wb = Workbook::new();
        wb.add_sheet("Something Else");
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
    }

    #[test]
    fn replay_rename_sheet_invalid_id_errors() {
        let mut log = OpLog::new();
        log.append(Op::RenameSheet {
            id: 7,
            old_name: "Sheet1".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(matches!(err, ReplayError::InvalidSheet { .. }));
    }

    #[test]
    fn replay_rename_sheet_duplicate_target_errors() {
        // Two sheets exist; renaming the first to the second's name must
        // fail through SheetRenameRejected.
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Sheet1".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::AddSheet {
            name: "Sheet2".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::RenameSheet {
            id: 0,
            old_name: "Sheet1".to_owned(),
            new_name: "Sheet2".to_owned(),
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(matches!(err, ReplayError::SheetRenameRejected { .. }));
    }

    #[test]
    fn replay_rename_inside_batchcommit() {
        // Producer pattern: rewrite-then-rename batched as a single
        // BatchCommit. Verify the batch replays atomically.
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "S1".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::AddSheet {
            name: "S2".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::PutFormula {
            sheet: 1, // S2!A1
            row: 0,
            col: 0,
            text: "S1!A1 + 1".to_owned(),
        })
        .unwrap();
        log.append(Op::BatchCommit {
            ops: vec![
                Op::PutFormula {
                    sheet: 1,
                    row: 0,
                    col: 0,
                    text: "SX!A1 + 1".to_owned(),
                },
                Op::RenameSheet {
                    id: 0,
                    old_name: "S1".to_owned(),
                    new_name: "SX".to_owned(),
                },
            ],
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet(0).unwrap().name(), "SX");
        assert_eq!(
            wb.formula_at(1, 0, 0).map(|s| s.as_ref().to_owned()),
            Some("SX!A1 + 1".to_owned())
        );
    }

    // ===== W5-92 (Phase 4.6.D) Op::SetName scoped variant =====

    #[test]
    fn replay_set_name_sheet_scoped_lands_on_sheet() {
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "S1".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::SetName {
            scope: Some(0),
            name: "Rate".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.21),
            },
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        // Sheet-scoped name present on sheet 0.
        assert!(matches!(
            wb.sheet(0).unwrap().scoped_names().lookup_ci("Rate"),
            Some(ql_storage::NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        // Workbook-scoped table is empty (sheet-scoped doesn't bleed up).
        assert!(wb.names().is_empty());
    }

    #[test]
    fn replay_set_name_scope_none_lands_on_workbook() {
        // Backwards-compat: scope: None (the v3+old wire shape) still
        // routes to the workbook scope, matching the historical behavior.
        let mut log = OpLog::new();
        log.append(Op::SetName {
            scope: None,
            name: "Rate".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.10),
            },
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(matches!(
            wb.names().lookup_ci("Rate"),
            Some(ql_storage::NamedTarget::Constant(Value::Number(n))) if n == 0.10
        ));
        // Sheet 0 has no scoped entry.
        assert!(wb.sheet(0).unwrap().scoped_names().is_empty());
    }

    #[test]
    fn replay_set_name_scope_unknown_sheet_errors() {
        let mut log = OpLog::new();
        log.append(Op::SetName {
            scope: Some(7),
            name: "X".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(1.0),
            },
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(
            matches!(err, ReplayError::InvalidSheet { sheet: 7, .. }),
            "expected InvalidSheet, got {err:?}"
        );
    }

    #[test]
    fn replay_set_name_scope_reserved_name_rejected() {
        // The reserved-name guard fires on the sheet-scoped path too.
        let mut log = OpLog::new();
        log.append(Op::SetName {
            scope: Some(0),
            name: "AI".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(42.0),
            },
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(
            matches!(err, ReplayError::NameRejected { .. }),
            "expected NameRejected, got {err:?}"
        );
    }

    // ===== W5-93 (Phase 4.6.E closure) Op::AddSheet name validation =====

    #[test]
    fn replay_add_sheet_canonical_duplicate_rejected() {
        // Codex HIGH-1: a hand-crafted log carrying conflicting names
        // must NOT enter the workbook silently.
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Sheet1".to_owned(),
            chunk_rows: 16,
        })
        .unwrap();
        log.append(Op::AddSheet {
            name: "SHEET1".to_owned(),
            chunk_rows: 16,
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(
            matches!(err, ReplayError::SheetNameRejected { index: 1, .. }),
            "expected SheetNameRejected at index 1, got {err:?}"
        );
        // Replay failed mid-log; the first sheet did land.
        assert_eq!(wb.sheet_count(), 1);
    }

    #[test]
    fn replay_add_sheet_reserved_char_rejected() {
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Bad?Sheet".to_owned(),
            chunk_rows: 16,
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(matches!(err, ReplayError::SheetNameRejected { .. }));
    }
}
