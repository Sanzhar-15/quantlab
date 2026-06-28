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

    // (3b) GAP-B-09: named-formula bodies (`NamedTarget::Formula`) are NOT
    // re-keyed by the storage-side `shift_name_table` — it passes `Formula`
    // through because `ql-storage` must not depend on `ql-formula-syntax` (the
    // text-shift lives here). Mirror the cell-formula text shift for every named
    // formula whose body references the edited sheet, emitting `Op::SetName`
    // with the shifted body. The binder still rejects `NamedTarget::Formula`
    // (`NamedFormulaUnsupported`, latent), but the bodies persist in the op log
    // + .qbook and round-trip, so the stored text MUST follow the structural
    // edit. (Cell/Range names are re-keyed by `shift_name_table` on the
    // structural op's OWN replay, which runs before these `SetName` ops.)
    let mut set_name_ops: Vec<Op> = Vec::new();
    // Workbook-scoped (global) names have no owning sheet → `owner_is_edited =
    // false`, so only sheet-QUALIFIED refs to the edited sheet shift. A bare
    // `A5` in a global name cannot be statically attributed to a sheet (its
    // owner depends on the using context), so it is left unchanged — a
    // documented v1 simplification (D1).
    collect_named_formula_shifts(
        workbook.names(),
        None,
        false,
        &edited_canonical,
        sheet,
        shift_axis,
        shift_op,
        &mut set_name_ops,
    );
    // Sheet-scoped names on EVERY sheet (a name scoped to sheet `sid` has bare
    // refs relative to `sid` → `owner_is_edited = (sid == sheet)`). Tombstoned
    // sheets are INCLUDED, not skipped: their storage + scoped names are retained
    // and restorable (v1 has no hard delete and never reuses a sheet id), so a
    // scoped Formula on a tombstoned sheet that qualifies the edited sheet must
    // still be shifted — else a later `RestoreSheet` resurfaces a stale body
    // (Codex w141 HIGH). Replay's `SetName { scope: Some(sid) }` writes the
    // retained slot via `sheet_mut`, which does NOT tombstone-filter, so the op
    // applies correctly even for a tombstoned `sid`.
    let sheet_count = workbook.sheet_count() as SheetId;
    for sid in 0..sheet_count {
        // `sid < sheet_count == sheets.len()` → always Some; fail loud rather
        // than silently dropping a sheet's scoped names if that ever breaks.
        let s = workbook
            .sheet(sid)
            .expect("sheet(sid): sid < sheet_count is an invariant");
        collect_named_formula_shifts(
            s.scoped_names(),
            Some(sid),
            sid == sheet,
            &edited_canonical,
            sheet,
            shift_axis,
            shift_op,
            &mut set_name_ops,
        );
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
    let mut ops: Vec<Op> = Vec::with_capacity(put_formula_ops.len() + set_name_ops.len() + 1);
    ops.push(structural_op);
    ops.extend(put_formula_ops);
    // SetName ops land LAST: the structural op (replayed first) runs
    // `shift_name_table`, which re-keys `Cell`/`Range` names and passes `Formula`
    // through unchanged; these `SetName` ops then overwrite the `Formula` targets
    // with their shifted bodies. (No `Formula` name is ever dropped here — a
    // named formula is not coordinate-located, so a ref into a deleted block
    // becomes `#REF!` in the body rather than removing the binding — D2.)
    ops.extend(set_name_ops);
    Ok(ops)
}

/// Shift the bodies of every `NamedTarget::Formula` in `table` whose text
/// references the edited sheet, pushing an `Op::SetName` carrying the shifted
/// body into `out`. `scope` is the op's name scope (`None` = workbook-scoped,
/// `Some(sheet)` = that sheet's scoped table). `owner_is_edited` controls
/// whether bare (unqualified) refs in the body shift — see GAP-B-09 / D1.
///
/// A body that does not reference the edited sheet yields `None` from
/// [`ql_formula_syntax::shift_formula_text`] → no op (no redundant rewrite). A
/// body whose lex/parse fails (corrupt input) also yields `None` → left
/// unchanged (NF-07: the same documented silent-skip contract as the
/// cell-formula path; a body that cannot lex/parse also cannot bind, so no NEW
/// error is hidden — the corruption is surfaced at bind time, not here).
#[allow(clippy::too_many_arguments)]
fn collect_named_formula_shifts(
    table: &ql_storage::NameTable,
    scope: Option<SheetId>,
    owner_is_edited: bool,
    edited_canonical: &str,
    edited_id: SheetId,
    shift_axis: ql_formula_syntax::ShiftAxis,
    shift_op: ql_formula_syntax::ShiftOp,
    out: &mut Vec<Op>,
) {
    use ql_storage::NamedTarget;
    let scope_desc = ql_formula_syntax::ShiftScope {
        edited_canonical,
        edited_id,
        owner_is_edited,
    };
    for (name, target) in table.iter() {
        let NamedTarget::Formula(body) = target else {
            continue;
        };
        if let Some(new_body) =
            ql_formula_syntax::shift_formula_text(body.as_ref(), shift_axis, shift_op, scope_desc)
        {
            out.push(Op::SetName {
                scope,
                name: name.as_ref().to_ascii_uppercase(),
                target: ql_io::NamedTargetWire::from_target(&NamedTarget::Formula(
                    std::sync::Arc::from(new_body.as_str()),
                )),
            });
        }
    }
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

    // ========================================================================
    // GAP-B-09 — named-formula (`NamedTarget::Formula`) bodies shift on
    // insert/delete. The structural op's own replay re-keys Cell/Range names
    // (`shift_name_table`); these tests cover the producer-emitted `SetName`
    // ops that carry the shifted FORMULA bodies (which storage cannot rewrite).
    // ========================================================================

    use ql_storage::{NamedTarget, Workbook};
    use std::sync::Arc;

    /// Decode every `SetName` op in a batch to `(scope, name, target)`.
    fn set_names(ops: &[Op]) -> Vec<(Option<ql_types::SheetId>, String, NamedTarget)> {
        ops.iter()
            .filter_map(|op| match op {
                Op::SetName {
                    scope,
                    name,
                    target,
                } => Some((
                    *scope,
                    name.clone(),
                    target.to_target(name).expect("decode wire target"),
                )),
                _ => None,
            })
            .collect()
    }

    fn formula_body(t: &NamedTarget) -> &str {
        match t {
            NamedTarget::Formula(b) => b.as_ref(),
            other => panic!("expected NamedTarget::Formula, got {other:?}"),
        }
    }

    #[test]
    fn b09_global_named_formula_qualified_ref_shifts_on_row_insert() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        // Body refs S0!A5 (row index 4). Insert 2 rows at 0 → A5 → A7.
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("S0!A5 - 1")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        // Structural op lands first; SetName ops land last.
        assert!(matches!(ops[0], Op::InsertRows { .. }));
        let names = set_names(&ops);
        assert_eq!(names.len(), 1, "one SetName for the named formula");
        assert_eq!(names[0].0, None, "workbook-scoped");
        assert_eq!(names[0].1, "PROFIT");
        let body = formula_body(&names[0].2);
        assert!(body.contains("S0!A7"), "got {body:?}");
        assert!(!body.contains("A5"), "stale ref survived: {body:?}");
    }

    #[test]
    fn b09_global_named_formula_unqualified_ref_does_not_shift() {
        // D1: a workbook-scoped name has no owning sheet → bare refs cannot be
        // attributed to the edited sheet, so they are left unchanged.
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        wb.set_name("Bare", NamedTarget::Formula(Arc::from("A5 - 1")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        assert!(
            set_names(&ops).is_empty(),
            "global bare ref must not shift (D1)"
        );
    }

    #[test]
    fn b09_scoped_named_formula_bare_ref_shifts_on_owning_sheet() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        wb.sheet_mut(s0)
            .unwrap()
            .set_scoped_name("Bare", NamedTarget::Formula(Arc::from("A5 - 1")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        let names = set_names(&ops);
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].0, Some(s0), "sheet-scoped to the edited sheet");
        let body = formula_body(&names[0].2);
        assert!(body.contains("A7"), "got {body:?}");
        assert!(!body.contains("A5"), "got {body:?}");
    }

    #[test]
    fn b09_scoped_named_formula_bare_ref_on_other_sheet_does_not_shift() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        let s1 = wb.add_sheet("S1");
        // Bare ref scoped to S1 is relative to S1; editing S0 must not touch it.
        wb.sheet_mut(s1)
            .unwrap()
            .set_scoped_name("Bare", NamedTarget::Formula(Arc::from("A5 - 1")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        assert!(set_names(&ops).is_empty());
    }

    #[test]
    fn b09_named_formula_ref_into_deleted_block_becomes_ref_error_kept() {
        // D2: deleting the row the ref lives on turns it into #REF! in the body;
        // the binding is KEPT (a named formula is not coordinate-located).
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("S0!A5 - 1")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Delete { start: 4, end: 4 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        let names = set_names(&ops);
        assert_eq!(names.len(), 1, "name kept, body rewritten to #REF!");
        let body = formula_body(&names[0].2);
        assert!(body.contains("#REF!"), "got {body:?}");
    }

    #[test]
    fn b09_named_formula_referencing_other_sheet_is_no_op() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        let _s1 = wb.add_sheet("S1");
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("S1!A5 - 1")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        assert!(set_names(&ops).is_empty(), "unrelated sheet → no rewrite");
    }

    #[test]
    fn b09_named_formula_qualified_col_ref_shifts_on_column_insert() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        // C1 = col index 2. Insert 1 col at 0 → C → D.
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("S0!C1 + 1")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Col,
            StructuralKind::Insert { at: 0, count: 1 },
            ql_types::MAX_COLUMN,
        )
        .unwrap();
        let names = set_names(&ops);
        assert_eq!(names.len(), 1);
        let body = formula_body(&names[0].2);
        assert!(body.contains("S0!D1"), "got {body:?}");
        assert!(!body.contains("C1"), "got {body:?}");
    }

    #[test]
    fn b09_cell_and_range_names_untouched_by_producer_left_to_shift_name_table() {
        // The producer only emits SetName for FORMULA bodies; Cell/Range names
        // are re-keyed by `shift_name_table` on the structural op's replay, so
        // the producer must NOT emit SetName ops for them.
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        wb.set_name(
            "Anchor",
            NamedTarget::Cell(ql_types::Address::new(s0, 4, 0)),
        )
        .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        assert!(
            set_names(&ops).is_empty(),
            "Cell names are shift_name_table's job, not the producer's"
        );
    }

    #[test]
    fn b09_scoped_named_formula_qualified_ref_into_edited_sheet_shifts() {
        // owner_is_edited=false (scoped to S1, editing S0) BUT a QUALIFIED ref to
        // S0 must still shift — this quadrant (scoped + qualified-cross-sheet) is
        // load-bearing: a refactor that ANDed owner_is_edited into Name-ref
        // matching would silently corrupt it.
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        let s1 = wb.add_sheet("S1");
        wb.sheet_mut(s1)
            .unwrap()
            .set_scoped_name("X", NamedTarget::Formula(Arc::from("S0!A5 - 1")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        let names = set_names(&ops);
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].0, Some(s1));
        let body = formula_body(&names[0].2);
        assert!(body.contains("S0!A7"), "got {body:?}");
    }

    #[test]
    fn b09_tombstoned_sheet_scoped_named_formula_still_shifts() {
        // Codex w141 HIGH regression: a scoped formula on a TOMBSTONED sheet that
        // qualifies the edited sheet must still shift — the sheet is restorable,
        // so skipping it would resurface a stale body on RestoreSheet.
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        let s1 = wb.add_sheet("S1");
        wb.sheet_mut(s1)
            .unwrap()
            .set_scoped_name("X", NamedTarget::Formula(Arc::from("S0!A5 - 1")))
            .unwrap();
        wb.remove_sheet(s1); // tombstone (storage + scoped names retained)
        assert!(wb.is_sheet_removed(s1));
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        let names = set_names(&ops);
        assert_eq!(
            names.len(),
            1,
            "tombstoned sheet's scoped formula must still shift"
        );
        assert_eq!(names[0].0, Some(s1));
        let body = formula_body(&names[0].2);
        assert!(body.contains("S0!A7"), "got {body:?}");
    }

    #[test]
    fn b09_mixed_qualified_and_bare_ref_global_shifts_only_qualified() {
        // D1: in a workbook-scoped body, the qualified S0! ref shifts; the bare
        // ref (no owning sheet) does NOT.
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        wb.set_name("Mix", NamedTarget::Formula(Arc::from("S0!A5 + B3")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        let names = set_names(&ops);
        assert_eq!(names.len(), 1);
        let body = formula_body(&names[0].2);
        assert!(body.contains("S0!A7"), "qualified must shift: {body:?}");
        assert!(
            body.contains("B3"),
            "bare ref must NOT shift (D1): {body:?}"
        );
    }

    #[test]
    fn b09_named_formula_col_delete_becomes_ref_error() {
        // D2 on the column axis (the row-axis case is covered above).
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("S0!C1 + 1")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Col,
            StructuralKind::Delete { start: 2, end: 2 }, // delete col C
            ql_types::MAX_COLUMN,
        )
        .unwrap();
        let names = set_names(&ops);
        assert_eq!(names.len(), 1);
        let body = formula_body(&names[0].2);
        assert!(body.contains("#REF!"), "got {body:?}");
    }

    #[test]
    fn b09_corrupt_named_formula_body_does_not_panic() {
        // NF-07: a body that fails to lex/parse is handled gracefully (no panic);
        // the batch is still well-formed. (Whether a partial shift is emitted
        // depends on the parser; the contract here is "no crash".)
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        wb.set_name("Bad", NamedTarget::Formula(Arc::from("S0!A5 )")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        assert!(matches!(ops[0], Op::InsertRows { .. }));
    }

    #[test]
    fn b09_end_to_end_replay_applies_shifted_named_formula_body() {
        // End-to-end: build batch → append → replay onto the pre-edit baseline →
        // assert the shifted body survived shift_name_table + the wire round-trip.
        use ql_oplog::OpLog;
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("S0!A5 - 1")))
            .unwrap();
        let ops = build_structural_batch(
            &wb,
            s0,
            StructuralAxis::Row,
            StructuralKind::Insert { at: 0, count: 2 },
            ql_types::MAX_ROW,
        )
        .unwrap();
        let mut log = OpLog::new();
        log.append(Op::BatchCommit { ops }).unwrap();
        let reg = ql_functions::default_registry();
        let mut replay_wb = wb.clone(); // baseline still has Profit = "S0!A5 - 1"
        ql_oplog::replay_into(&log, &mut replay_wb, &reg).unwrap();
        match replay_wb.names().lookup_ci("Profit") {
            Some(NamedTarget::Formula(b)) => {
                assert!(b.contains("S0!A7"), "replayed body not shifted: {b:?}");
                assert!(!b.contains("A5"), "stale ref survived replay: {b:?}");
            }
            other => panic!("expected Formula after replay, got {other:?}"),
        }
    }
}
