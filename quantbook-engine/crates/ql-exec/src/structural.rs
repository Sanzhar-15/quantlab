//! `structural` — the **audited** insert/delete-rows/columns producer core.
//!
//! # Why this module exists
//!
//! Insert/delete of rows & columns is a **silent-data-corruption-class**
//! feature: a structural edit must (a) shift the POSITIONAL storage (handled by
//! `ql_storage::Workbook::{insert,delete}_{rows,columns}`) AND (b) rewrite the
//! TEXT of every formula whose references point INTO the edited sheet so a ref
//! FOLLOWS its target cell instead of silently pointing at the wrong one. The
//! producer below assembles the `[structural_op, PutFormula×N]` `BatchCommit`
//! that performs both halves atomically on op-log replay.
//!
//! This logic was originally inline in the `CollabSession` napi producer
//! (`ql-bindings-node` `append_structural_edit`) and took **7 audit passes**
//! (including two conductor megaudits that caught silent-corruption HIGHs the
//! dev-time audits + the IDE gate all shared a blind spot on). It is extracted
//! here VERBATIM so the owning `WorkbookSession` (the path the product grid
//! actually runs on) reuses the exact same audited core rather than
//! re-deriving it — duplicating it would re-open the bug surface.
//!
//! # Crate-placement constraint
//!
//! This MUST live in `ql-exec`, NOT `ql-storage`: the formula-text rewrite
//! calls `ql_formula_syntax::shift_formula_text`, and **`ql-storage` must not
//! depend on `ql-formula-syntax`** (that edge would create the layering
//! inversion the workspace deliberately forbids). `ql-exec` already depends on
//! `ql-storage` + `ql-oplog` + `ql-formula-syntax`, so it is the correct home.
//!
//! # No-Fallbacks
//!
//! Every rejection is an explicit [`StructuralError`] — never a silent no-op or
//! a defaulted value. A malformed edit (count==0, off-grid, table-split,
//! tombstoned/missing sheet) surfaces loudly here, BEFORE any op is appended.

use ql_oplog::Op;
use ql_storage::Workbook;
use ql_types::SheetId;

/// Which axis a structural edit operates on (mirrors
/// [`ql_formula_syntax::ShiftAxis`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StructuralAxis {
    Row,
    Col,
}

/// The kind of structural edit (mirrors [`ql_formula_syntax::ShiftOp`]).
/// Coordinates are 0-indexed; `Delete` is INCLUSIVE `[start, end]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StructuralKind {
    Insert { at: u32, count: u32 },
    Delete { start: u32, end: u32 },
}

/// A structural-edit producer rejection. Each variant carries the precise
/// human-readable `message`; consumers (napi binding, owning session) map it to
/// their own error type (a `[bad_argument]` JS error / an `EngineError`
/// `BadArgument`). Per No-Fallbacks every rejection is one of these — never a
/// silent no-op.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StructuralError {
    /// The target `sheet` index is out of range for the workbook.
    SheetMissing { message: String },
    /// The target `sheet` is tombstoned (deleted): a structural edit would
    /// shift cross-sheet refs INTO a removed sheet, corrupting other sheets'
    /// formulas as if the deleted sheet changed.
    SheetTombstoned { message: String },
    /// The clone-preflight of the POSITIONAL edit rejected it (count==0,
    /// off-grid, invalid-range, or a table-footprint split).
    Preflight { message: String },
}

impl StructuralError {
    /// The precise, human-readable rejection message (the same string for every
    /// variant — the variant carries the *class*, the message the *detail*).
    pub fn message(&self) -> &str {
        match self {
            StructuralError::SheetMissing { message }
            | StructuralError::SheetTombstoned { message }
            | StructuralError::Preflight { message } => message,
        }
    }
}

impl std::fmt::Display for StructuralError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for StructuralError {}

/// Compute the POST-shift `(row, col)` of a formula cell that lives ON the
/// edited sheet. `None` if the cell falls inside a deleted block or is pushed
/// off-grid (the structural op drops its `formula_cells` key, so no
/// `PutFormula` should be emitted for it).
///
/// This is the position half of the producer; the TEXT half is
/// [`ql_formula_syntax::shift_formula_text`]. They MUST stay in lock-step (this
/// returns `None` exactly when `shift_formula_text` would emit `#REF!` for the
/// cell's OWN coordinate) — that symmetry is what the audited producer relies
/// on to never resurrect a deleted formula cell.
pub fn shifted_position(
    row: u32,
    col: u32,
    axis: StructuralAxis,
    kind: StructuralKind,
    axis_max: u32,
) -> Option<(u32, u32)> {
    let coord = match axis {
        StructuralAxis::Row => row,
        StructuralAxis::Col => col,
    };
    let new_coord = match kind {
        StructuralKind::Insert { at, count } => {
            if coord < at {
                coord
            } else {
                let c = coord as u64 + count as u64;
                if c > axis_max as u64 {
                    return None;
                }
                c as u32
            }
        }
        StructuralKind::Delete { start, end } => {
            if coord < start {
                coord
            } else if coord <= end {
                return None; // deleted
            } else {
                coord - (end - start + 1)
            }
        }
    };
    Some(match axis {
        StructuralAxis::Row => (new_coord, col),
        StructuralAxis::Col => (row, new_coord),
    })
}

/// Build the `[structural_op, PutFormula×N]` op vector for one structural edit.
///
/// The caller wraps the returned `Vec` in an `Op::BatchCommit { ops }` and
/// appends it to its OWN op-log (the napi `CollabSession` path and the owning
/// `WorkbookSession` path share this core but own different logs).
///
/// `workbook` is the live (already-rebuilt / in-session) workbook the edit
/// applies to. `axis_max` is `ql_types::MAX_ROW` for a row edit or
/// `ql_types::MAX_COLUMN` for a column edit.
///
/// # What it does (the audited sequence — DO NOT re-derive)
///
/// 1. **Validate** the sheet exists and is not tombstoned.
/// 2. **Clone-preflight** the POSITIONAL edit on a `Workbook` clone so a
///    table-split / off-grid / invalid-range / count==0 rejection surfaces as a
///    clean [`StructuralError::Preflight`] HERE, instead of appending an op that
///    fails later at replay time. `Workbook::clone` is shallow over Arrow chunk
///    `Arc`s (cheap refcount bumps).
/// 3. For every formula in `workbook.iter_formulas()`, compute the TEXT shift
///    via [`ql_formula_syntax::shift_formula_text`] and emit `Op::PutFormula` at
///    the formula's POST-shift position via [`shifted_position`] (skip a formula
///    whose OWN cell was deleted — `shifted_position` returns `None`).
/// 4. Assemble `[structural_op, PutFormula×N]`.
///
/// # Errors
///
/// [`StructuralError`] for a missing/tombstoned sheet or a preflight failure.
/// No other failure mode exists — the op assembly itself is infallible.
pub fn build_structural_batch(
    workbook: &Workbook,
    sheet: SheetId,
    axis: StructuralAxis,
    kind: StructuralKind,
    axis_max: u32,
) -> Result<Vec<Op>, StructuralError> {
    // (1) Sheet must exist.
    if workbook.sheet(sheet).is_none() {
        return Err(StructuralError::SheetMissing {
            message: format!(
                "sheet {sheet} does not exist (workbook has {} sheets)",
                workbook.sheet_count()
            ),
        });
    }
    // A structural edit on a tombstoned sheet is a replay no-op, but the
    // cross-sheet formula-text rewrites below would still shift refs INTO the
    // (deleted) sheet — corrupting other sheets' formulas as if the deleted
    // sheet changed. Refuse it. (Codex L5 MED-2 closure, carried verbatim.)
    if workbook.is_sheet_removed(sheet) {
        return Err(StructuralError::SheetTombstoned {
            message: format!(
                "sheet {sheet} is deleted (tombstoned); structural edits on a \
                 removed sheet are not permitted"
            ),
        });
    }

    // (2) Preflight the POSITIONAL edit on a CLONE of the workbook so a
    // table-split / off-grid / invalid-range / count==0 rejection surfaces as a
    // clean error HERE, instead of appending an op that fails later at replay
    // time. (Codex L5 MED-3 closure, carried verbatim.)
    {
        let mut probe = workbook.clone();
        let probe_result = match (axis, kind) {
            (StructuralAxis::Row, StructuralKind::Insert { at, count }) => {
                probe.insert_rows(sheet, at, count)
            }
            (StructuralAxis::Row, StructuralKind::Delete { start, end }) => {
                probe.delete_rows(sheet, start, end)
            }
            (StructuralAxis::Col, StructuralKind::Insert { at, count }) => {
                probe.insert_columns(sheet, at, count)
            }
            (StructuralAxis::Col, StructuralKind::Delete { start, end }) => {
                probe.delete_columns(sheet, start, end)
            }
        };
        if let Err(e) = probe_result {
            return Err(StructuralError::Preflight {
                message: e.to_string(),
            });
        }
    }

    // Build the shift descriptors for the formula-text rewrite + the op.
    let edited_canonical =
        Workbook::canonical_sheet_name(workbook.sheet(sheet).expect("sheet checked above").name());
    let shift_op = match (axis, kind) {
        (_, StructuralKind::Insert { at, count }) => {
            ql_formula_syntax::ShiftOp::Insert { at, count }
        }
        (_, StructuralKind::Delete { start, end }) => {
            ql_formula_syntax::ShiftOp::Delete { start, end }
        }
    };
    let shift_axis = match axis {
        StructuralAxis::Row => ql_formula_syntax::ShiftAxis::Row,
        StructuralAxis::Col => ql_formula_syntax::ShiftAxis::Col,
    };

    // (3) Compute formula-text rewrites for every formula referencing the
    // edited sheet (refs that resolve to it shift; others pass through).
    let mut put_formula_ops: Vec<Op> = Vec::new();
    for (s, r, c, text) in workbook.iter_formulas() {
        let scope = ql_formula_syntax::ShiftScope {
            edited_canonical: &edited_canonical,
            edited_id: sheet,
            owner_is_edited: s == sheet,
        };
        if let Some(new_text) =
            ql_formula_syntax::shift_formula_text(text.as_ref(), shift_axis, shift_op, scope)
        {
            // Emit at the formula's POST-shift position so the op lands on the
            // cell after the structural op re-keys it. A formula ON the edited
            // sheet moves with the shift; one on ANOTHER sheet keeps its
            // position (only its TEXT changed).
            let (pr, pc) = if s == sheet {
                match shifted_position(r, c, axis, kind, axis_max) {
                    Some(pos) => pos,
                    // The formula's own cell was deleted by this edit — the
                    // structural op drops its formula_cells key, so emitting a
                    // PutFormula here would resurrect it. Skip it.
                    None => continue,
                }
            } else {
                (r, c)
            };
            put_formula_ops.push(Op::PutFormula {
                sheet: s,
                row: pr,
                col: pc,
                text: new_text,
            });
        }
    }

    // (4) Assemble the batch: structural op first, then the text rewrites at
    // their post-shift positions.
    let structural_op = match (axis, kind) {
        (StructuralAxis::Row, StructuralKind::Insert { at, count }) => {
            Op::InsertRows { sheet, at, count }
        }
        (StructuralAxis::Row, StructuralKind::Delete { start, end }) => {
            Op::DeleteRows { sheet, start, end }
        }
        (StructuralAxis::Col, StructuralKind::Insert { at, count }) => {
            Op::InsertColumns { sheet, at, count }
        }
        (StructuralAxis::Col, StructuralKind::Delete { start, end }) => {
            Op::DeleteColumns { sheet, start, end }
        }
    };
    let mut ops: Vec<Op> = Vec::with_capacity(put_formula_ops.len() + 1);
    ops.push(structural_op);
    ops.extend(put_formula_ops);
    Ok(ops)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // shifted_position — the position half of the producer.
    // (Moved verbatim from the ql-bindings-node CollabSession tests so the
    // audited coverage travels WITH the audited code.)
    // ========================================================================

    #[test]
    fn shifted_position_row_insert() {
        // Row 4 (A5), insert 1 at index 0 → row 5.
        assert_eq!(
            shifted_position(
                4,
                0,
                StructuralAxis::Row,
                StructuralKind::Insert { at: 0, count: 1 },
                ql_types::MAX_ROW
            ),
            Some((5, 0))
        );
        // Above the insert point → unchanged.
        assert_eq!(
            shifted_position(
                2,
                0,
                StructuralAxis::Row,
                StructuralKind::Insert { at: 3, count: 1 },
                ql_types::MAX_ROW
            ),
            Some((2, 0))
        );
    }

    #[test]
    fn shifted_position_row_delete_drops_in_block() {
        // Row 2 deleted in [2,2] → None (cell gone).
        assert_eq!(
            shifted_position(
                2,
                0,
                StructuralAxis::Row,
                StructuralKind::Delete { start: 2, end: 2 },
                ql_types::MAX_ROW
            ),
            None
        );
        // Row 9 below the block [1,2] → 9 - 2 = 7.
        assert_eq!(
            shifted_position(
                9,
                0,
                StructuralAxis::Row,
                StructuralKind::Delete { start: 1, end: 2 },
                ql_types::MAX_ROW
            ),
            Some((7, 0))
        );
    }

    #[test]
    fn shifted_position_col_insert() {
        assert_eq!(
            shifted_position(
                0,
                1,
                StructuralAxis::Col,
                StructuralKind::Insert { at: 0, count: 1 },
                ql_types::MAX_COLUMN
            ),
            Some((0, 2))
        );
    }

    #[test]
    fn shifted_position_row_insert_overflow_is_none() {
        // The last row pushed past MAX_ROW → None.
        assert_eq!(
            shifted_position(
                ql_types::MAX_ROW,
                0,
                StructuralAxis::Row,
                StructuralKind::Insert { at: 0, count: 1 },
                ql_types::MAX_ROW
            ),
            None
        );
    }
}
