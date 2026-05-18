//! Spill-anchor storage — workbook-level table mapping anchor cells to
//! their spill shapes, with a reverse map from each spilled-into cell
//! back to its anchor.
//!
//! **Phase 4.7.H (W5-101):** introduces the storage data structures for
//! dynamic-array spills. Per design doc § 7:
//! `docs/architecture/2026-05-14-array-formulas-and-spills.md` § 7.
//!
//! ## Two-map shape
//!
//! ```text
//! SpillAnchorTable {
//!     anchors:  HashMap<(SheetId, RowId, ColId), SpillShape>,
//!     targets:  HashMap<(SheetId, RowId, ColId), (SheetId, RowId, ColId)>,
//! }
//! ```
//!
//! - `anchors` — one entry per spilling formula. Key is the anchor cell
//!   (top-left of the spill rectangle); value is the rectangle's
//!   `(rows, cols)`.
//! - `targets` — reverse map for fast `O(1)` "is this cell part of a
//!   spill?" lookup at user-write / dep-extraction time. Key is each
//!   cell in the spill rectangle (including the anchor itself); value
//!   is the anchor.
//!
//! ## Invariants
//!
//! 1. **Both-or-neither:** for every key in `anchors`, exactly
//!    `shape.rows * shape.cols` matching keys exist in `targets`, all
//!    pointing back at the anchor. `register` and `unregister` are the
//!    only mutators and preserve this jointly.
//! 2. **Anchor-is-also-target:** the anchor cell itself is in `targets`
//!    with `targets[(anchor)] = (anchor)`. This simplifies the
//!    spill-detection logic at user-write time — a single map lookup
//!    answers "is this cell part of a spill (anchor or otherwise)?".
//! 3. **Disjoint footprints:** no cell belongs to two different anchors'
//!    targets. The `register` collision check enforces this.
//!
//! ## Why map-only
//!
//! Per Codex W5-94 design review MEDIUM (§ 7): `SpillAnchorTable` is
//! intentionally map-only. Overlay clearing on spill removal lives in
//! `Workbook::clear_spill_at`, which couples the table mutation with
//! `Sheet::clear_computed` calls because the workbook owns sheet
//! access. Keeping the table layer pure-map keeps testability +
//! responsibility clean.

use std::collections::HashMap;

use ql_types::{ColId, RowId, SheetId, MAX_COLUMN, MAX_ROW};

/// Spill-rectangle dimensions. `rows * cols` is the total cell count;
/// degenerate shapes (`rows == 0` or `cols == 0`) are runtime-detected
/// at the WORKBOOK / RUNTIME boundary before reaching `register` —
/// `SpillAnchorTable::register` requires both `rows >= 1` and `cols >= 1`
/// per the invariant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SpillShape {
    pub rows: u32,
    pub cols: u32,
}

impl SpillShape {
    /// Construct a shape; both dimensions must be >= 1.
    pub fn new(rows: u32, cols: u32) -> Self {
        Self { rows, cols }
    }

    /// Total cell count (rows * cols).
    pub fn cell_count(&self) -> u64 {
        (self.rows as u64) * (self.cols as u64)
    }
}

/// Errors emitted by `SpillAnchorTable::register` when the rectangle
/// would collide with an existing spill OR overlap an existing anchor.
///
/// The runtime spill-writeback path (Phase 4.7.J) maps these into
/// `Value::Error(ErrorValue::Spill)` at the anchor cell; the storage
/// layer surfaces them structurally so callers can distinguish causes.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum SpillBlockError {
    /// A non-anchor cell inside the proposed spill rectangle is
    /// already a target of a DIFFERENT existing spill. The runtime
    /// surfaces this as `#SPILL!` at the proposed anchor.
    #[error(
        "spill blocked: cell ({sheet},{row},{col}) is already a target of \
         anchor ({anchor_sheet},{anchor_row},{anchor_col})"
    )]
    TargetCellOccupied {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        anchor_sheet: SheetId,
        anchor_row: RowId,
        anchor_col: ColId,
    },

    /// The proposed anchor cell IS an existing spill anchor (different
    /// shape, or attempting to register twice without clearing first).
    /// The runtime should call `clear_spill_at(anchor)` before re-
    /// registering — see design § 8.3 (re-eval invariant).
    #[error(
        "spill blocked: cell ({sheet},{row},{col}) is already an anchor; \
         clear it first via clear_spill_at"
    )]
    AnchorAlreadyExists {
        sheet: SheetId,
        row: RowId,
        col: ColId,
    },

    /// Spill rectangle has zero rows or zero cols. Degenerate-shape
    /// arrays from functions like `FILTER` with an all-false mask are
    /// runtime errors per design § 8.1; the storage layer rejects
    /// degenerate registration as a defensive guard.
    #[error(
        "spill blocked: degenerate shape ({rows} rows, {cols} cols) — both \
         dimensions must be >= 1"
    )]
    DegenerateShape { rows: u32, cols: u32 },

    /// **W5-101-AUDIT (Codex MEDIUM-2):** spill rectangle would extend
    /// beyond Excel worksheet bounds (`MAX_ROW = 1,048,575`, `MAX_COLUMN
    /// = 16,383`). Without this check, `anchor + shape` wraps via
    /// release-build u32 arithmetic and can register cells at impossible
    /// coordinates. The runtime spill-writeback path (Phase 4.7.J) maps
    /// this to `Value::Error(ErrorValue::Spill)` at the anchor.
    #[error(
        "spill blocked: rectangle from ({sheet},{row},{col}) sized \
         ({rows}x{cols}) extends beyond worksheet bounds \
         (MAX_ROW={MAX_ROW}, MAX_COLUMN={MAX_COLUMN})"
    )]
    OutOfBounds {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        rows: u32,
        cols: u32,
    },
}

/// Returned by `unregister` when called on a cell that isn't an anchor.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("no spill anchor at ({sheet},{row},{col})")]
pub struct SpillNotFoundError {
    pub sheet: SheetId,
    pub row: RowId,
    pub col: ColId,
}

/// Workbook-level spill-anchor table.
///
/// **Map-only:** mutations affect ONLY the two HashMaps. Computed-
/// overlay clearing on `unregister` is the workbook layer's job
/// (`Workbook::clear_spill_at`). See module-level docs for the
/// rationale.
#[derive(Clone, Debug, Default)]
pub struct SpillAnchorTable {
    anchors: HashMap<(SheetId, RowId, ColId), SpillShape>,
    targets: HashMap<(SheetId, RowId, ColId), (SheetId, RowId, ColId)>,
}

impl SpillAnchorTable {
    /// Empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Lookup an anchor by cell. Returns `Some(shape)` iff the cell is
    /// an active spill anchor. `O(1)`.
    pub fn anchor_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&SpillShape> {
        self.anchors.get(&(sheet, row, col))
    }

    /// Reverse lookup: the anchor that this cell is a target of.
    /// Returns `Some((anchor_s, anchor_r, anchor_c))` iff this cell is
    /// either an anchor or any non-anchor target cell. `O(1)`. Used by
    /// the runtime spill-invalidation path (Phase 4.7.K) — when a user
    /// writes a value at this cell, the anchor needs to re-evaluate.
    pub fn target_anchor(
        &self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
    ) -> Option<(SheetId, RowId, ColId)> {
        self.targets.get(&(sheet, row, col)).copied()
    }

    /// Register a new spill: `anchor` is the top-left cell, `shape` is
    /// the rectangle's `(rows, cols)`. Adds the anchor to `anchors` AND
    /// every cell in the rectangle to `targets`.
    ///
    /// Errors per `SpillBlockError`:
    /// - `AnchorAlreadyExists` — `anchor` is already in `anchors`.
    ///   Caller must `unregister(anchor)` first.
    /// - `TargetCellOccupied` — some cell inside the rectangle is in
    ///   `targets` already (a DIFFERENT spill claims it).
    /// - `DegenerateShape` — `shape.rows == 0` or `shape.cols == 0`.
    ///
    /// **Atomicity:** registration is all-or-nothing. If the collision
    /// scan finds an occupied target mid-iteration, NO entries are
    /// inserted — the table state is unchanged.
    pub fn register(
        &mut self,
        anchor: (SheetId, RowId, ColId),
        shape: SpillShape,
    ) -> Result<(), SpillBlockError> {
        if shape.rows == 0 || shape.cols == 0 {
            return Err(SpillBlockError::DegenerateShape {
                rows: shape.rows,
                cols: shape.cols,
            });
        }
        // **W5-101-AUDIT (Codex MEDIUM-2):** bounds check BEFORE any
        // iteration. Without this, `anchor.row + (shape.rows - 1)`
        // wraps in release builds, and the rectangle iteration would
        // touch cells at impossible row/col coordinates. The check
        // uses `checked_add` so overflow at the u32 boundary is also
        // surfaced as OutOfBounds rather than wrapping.
        let (asheet, arow, acol) = anchor;
        let last_row = arow.checked_add(shape.rows - 1).filter(|r| *r <= MAX_ROW);
        let last_col = acol
            .checked_add(shape.cols - 1)
            .filter(|c| *c <= MAX_COLUMN);
        if last_row.is_none() || last_col.is_none() {
            return Err(SpillBlockError::OutOfBounds {
                sheet: asheet,
                row: arow,
                col: acol,
                rows: shape.rows,
                cols: shape.cols,
            });
        }
        // Pre-check: anchor not already registered.
        if self.anchors.contains_key(&anchor) {
            return Err(SpillBlockError::AnchorAlreadyExists {
                sheet: asheet,
                row: arow,
                col: acol,
            });
        }
        // Pre-check: every cell in the rectangle is unoccupied. We
        // walk the WHOLE rectangle BEFORE inserting anything so a
        // collision in the middle doesn't leave a partial registration.
        // Per W5-101-AUDIT bounds check above, `arow + dr` and
        // `acol + dc` are guaranteed in-bounds at this point.
        for dr in 0..shape.rows {
            for dc in 0..shape.cols {
                let cell = (asheet, arow + dr, acol + dc);
                if let Some(existing_anchor) = self.targets.get(&cell) {
                    return Err(SpillBlockError::TargetCellOccupied {
                        sheet: cell.0,
                        row: cell.1,
                        col: cell.2,
                        anchor_sheet: existing_anchor.0,
                        anchor_row: existing_anchor.1,
                        anchor_col: existing_anchor.2,
                    });
                }
            }
        }
        // **W5-101-AUDIT (Codex LOW-1):** panic-atomicity. Pre-allocate
        // both maps so any allocation failure surfaces BEFORE we insert
        // — preventing a partial-insert state where `anchors` has the
        // new entry but `targets` panicked mid-loop. We use
        // `HashMap::reserve`, which aborts on allocation failure
        // (stable Rust doesn't expose a `Result`-returning variant for
        // `HashMap` allocation, and `try_reserve` is unavailable on the
        // pre-stabilized `HashMap` API). The panic-on-OOM effective
        // behavior matches the un-guarded pre-W5-101-AUDIT path —
        // explicit reserve makes the failure point earlier and
        // unambiguous. (Comment corrected W5-108 / Phase 4.7.O Codex
        // LOW: prior comment incorrectly attributed the semantics to
        // `try_reserve`, which is NOT used here.)
        let target_count = (shape.rows as usize) * (shape.cols as usize);
        self.anchors.reserve(1);
        self.targets.reserve(target_count);
        // Insertion. No partial state — all pre-checks passed AND
        // allocation is reserved.
        self.anchors.insert(anchor, shape);
        for dr in 0..shape.rows {
            for dc in 0..shape.cols {
                let cell = (asheet, arow + dr, acol + dc);
                self.targets.insert(cell, anchor);
            }
        }
        Ok(())
    }

    /// Remove a spill anchor + all its targets. Returns the cleared
    /// shape so callers (e.g. `Workbook::clear_spill_at`) can iterate
    /// the rectangle for overlay-clearing without re-querying.
    pub fn unregister(
        &mut self,
        anchor: (SheetId, RowId, ColId),
    ) -> Result<SpillShape, SpillNotFoundError> {
        let shape = self.anchors.remove(&anchor).ok_or(SpillNotFoundError {
            sheet: anchor.0,
            row: anchor.1,
            col: anchor.2,
        })?;
        let (asheet, arow, acol) = anchor;
        for dr in 0..shape.rows {
            for dc in 0..shape.cols {
                self.targets.remove(&(asheet, arow + dr, acol + dc));
            }
        }
        Ok(shape)
    }

    /// Iterator over `(anchor_cell, shape)` for every registered spill.
    /// Order is HashMap-iteration order — unspecified and may change
    /// across mutations. Callers that need a stable order must collect
    /// + sort.
    pub fn iter_anchors(
        &self,
    ) -> impl Iterator<Item = ((SheetId, RowId, ColId), &SpillShape)> + '_ {
        self.anchors.iter().map(|(k, v)| (*k, v))
    }

    /// Total anchor count (NOT total target-cell count).
    pub fn len(&self) -> usize {
        self.anchors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.anchors.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: SheetId, r: RowId, c: ColId) -> (SheetId, RowId, ColId) {
        (s, r, c)
    }

    #[test]
    fn empty_table_lookups_return_none() {
        let t = SpillAnchorTable::new();
        assert!(t.anchor_at(0, 0, 0).is_none());
        assert!(t.target_anchor(0, 0, 0).is_none());
        assert!(t.is_empty());
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn register_1x1_spill() {
        let mut t = SpillAnchorTable::new();
        t.register(at(0, 5, 3), SpillShape::new(1, 1)).unwrap();
        assert_eq!(t.anchor_at(0, 5, 3), Some(&SpillShape::new(1, 1)));
        // Anchor IS its own target.
        assert_eq!(t.target_anchor(0, 5, 3), Some(at(0, 5, 3)));
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn register_5x1_spill_populates_targets() {
        // `=SEQUENCE(5)` at A1 spills A1..A5.
        let mut t = SpillAnchorTable::new();
        let anchor = at(0, 0, 0);
        t.register(anchor, SpillShape::new(5, 1)).unwrap();
        for r in 0..5 {
            assert_eq!(t.target_anchor(0, r, 0), Some(anchor), "row {r}");
        }
        // Outside the rectangle: no entries.
        assert!(t.target_anchor(0, 5, 0).is_none());
        assert!(t.target_anchor(0, 0, 1).is_none());
    }

    #[test]
    fn register_2x3_spill_populates_all_cells() {
        // 2×3 rectangle at B2 covers B2:D3.
        let mut t = SpillAnchorTable::new();
        let anchor = at(0, 1, 1);
        t.register(anchor, SpillShape::new(2, 3)).unwrap();
        for dr in 0..2 {
            for dc in 0..3 {
                assert_eq!(
                    t.target_anchor(0, 1 + dr, 1 + dc),
                    Some(anchor),
                    "cell ({},{})",
                    1 + dr,
                    1 + dc
                );
            }
        }
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn register_rejects_anchor_already_exists() {
        let mut t = SpillAnchorTable::new();
        let anchor = at(0, 0, 0);
        t.register(anchor, SpillShape::new(3, 1)).unwrap();
        let err = t.register(anchor, SpillShape::new(3, 1)).unwrap_err();
        assert!(matches!(err, SpillBlockError::AnchorAlreadyExists { .. }));
    }

    #[test]
    fn register_rejects_target_collision_atomically() {
        // First spill at A1: 3x1. Second spill at A2: 3x1 — would
        // overlap A2, A3 with the first spill. Reject; no partial
        // insert.
        let mut t = SpillAnchorTable::new();
        t.register(at(0, 0, 0), SpillShape::new(3, 1)).unwrap();
        let len_before = t.len();
        let target_count_before = t.targets.len();
        let err = t.register(at(0, 1, 0), SpillShape::new(3, 1)).unwrap_err();
        match err {
            SpillBlockError::TargetCellOccupied {
                sheet,
                row,
                col,
                anchor_sheet,
                anchor_row,
                anchor_col,
            } => {
                // First collision encountered in iteration order: A2.
                assert_eq!((sheet, row, col), (0, 1, 0));
                assert_eq!((anchor_sheet, anchor_row, anchor_col), (0, 0, 0));
            }
            other => panic!("expected TargetCellOccupied, got {other:?}"),
        }
        // Atomicity: failed registration left the table unchanged.
        assert_eq!(t.len(), len_before);
        assert_eq!(t.targets.len(), target_count_before);
        assert!(t.anchor_at(0, 1, 0).is_none());
    }

    #[test]
    fn register_rejects_degenerate_zero_rows() {
        let mut t = SpillAnchorTable::new();
        let err = t.register(at(0, 0, 0), SpillShape::new(0, 3)).unwrap_err();
        assert!(matches!(
            err,
            SpillBlockError::DegenerateShape { rows: 0, cols: 3 }
        ));
    }

    #[test]
    fn register_rejects_degenerate_zero_cols() {
        let mut t = SpillAnchorTable::new();
        let err = t.register(at(0, 0, 0), SpillShape::new(3, 0)).unwrap_err();
        assert!(matches!(
            err,
            SpillBlockError::DegenerateShape { rows: 3, cols: 0 }
        ));
    }

    #[test]
    fn unregister_clears_anchor_and_all_targets() {
        let mut t = SpillAnchorTable::new();
        let anchor = at(0, 0, 0);
        t.register(anchor, SpillShape::new(2, 2)).unwrap();
        let shape = t.unregister(anchor).unwrap();
        assert_eq!(shape, SpillShape::new(2, 2));
        // Anchor gone.
        assert!(t.anchor_at(0, 0, 0).is_none());
        // All four target cells gone.
        for dr in 0..2 {
            for dc in 0..2 {
                assert!(
                    t.target_anchor(0, dr, dc).is_none(),
                    "cell ({dr},{dc}) still in targets"
                );
            }
        }
        assert!(t.is_empty());
    }

    #[test]
    fn unregister_unknown_anchor_errors() {
        let mut t = SpillAnchorTable::new();
        let err = t.unregister(at(0, 5, 5)).unwrap_err();
        assert_eq!(
            err,
            SpillNotFoundError {
                sheet: 0,
                row: 5,
                col: 5
            }
        );
    }

    #[test]
    fn register_unregister_register_works() {
        // Re-registering after unregister is the expected re-eval
        // pattern per design § 8.3.
        let mut t = SpillAnchorTable::new();
        let anchor = at(0, 0, 0);
        t.register(anchor, SpillShape::new(3, 1)).unwrap();
        t.unregister(anchor).unwrap();
        t.register(anchor, SpillShape::new(5, 1)).unwrap();
        assert_eq!(t.anchor_at(0, 0, 0), Some(&SpillShape::new(5, 1)));
        // New shape's targets are populated.
        assert_eq!(t.target_anchor(0, 4, 0), Some(anchor));
    }

    #[test]
    fn two_disjoint_spills_coexist() {
        // Spill A: 2x2 at (0,0). Spill B: 2x2 at (5,5).
        let mut t = SpillAnchorTable::new();
        let a = at(0, 0, 0);
        let b = at(0, 5, 5);
        t.register(a, SpillShape::new(2, 2)).unwrap();
        t.register(b, SpillShape::new(2, 2)).unwrap();
        assert_eq!(t.len(), 2);
        // Each cell maps to the right anchor.
        assert_eq!(t.target_anchor(0, 1, 1), Some(a));
        assert_eq!(t.target_anchor(0, 6, 6), Some(b));
    }

    #[test]
    fn spills_on_different_sheets_are_independent() {
        let mut t = SpillAnchorTable::new();
        let a = at(0, 2, 2);
        let b = at(1, 2, 2);
        t.register(a, SpillShape::new(3, 3)).unwrap();
        t.register(b, SpillShape::new(3, 3)).unwrap();
        assert_eq!(t.target_anchor(0, 2, 2), Some(a));
        assert_eq!(t.target_anchor(1, 2, 2), Some(b));
        // Cross-sheet doesn't bleed.
        assert!(t.target_anchor(0, 2, 5).is_none());
        assert!(t.target_anchor(1, 2, 5).is_none());
    }

    #[test]
    fn iter_anchors_yields_all_registered() {
        let mut t = SpillAnchorTable::new();
        t.register(at(0, 0, 0), SpillShape::new(1, 1)).unwrap();
        t.register(at(0, 5, 5), SpillShape::new(2, 2)).unwrap();
        let anchors: Vec<_> = t.iter_anchors().collect();
        assert_eq!(anchors.len(), 2);
        // Iteration order is unspecified; collect + assert membership.
        let cells: std::collections::HashSet<_> = anchors.iter().map(|(c, _)| *c).collect();
        assert!(cells.contains(&at(0, 0, 0)));
        assert!(cells.contains(&at(0, 5, 5)));
    }

    #[test]
    fn spill_shape_cell_count() {
        assert_eq!(SpillShape::new(5, 1).cell_count(), 5);
        assert_eq!(SpillShape::new(3, 4).cell_count(), 12);
        assert_eq!(SpillShape::new(1, 1).cell_count(), 1);
    }

    // ===== W5-101-AUDIT (Codex MEDIUM-2) — bounds checks =====

    #[test]
    fn register_rejects_spill_extending_past_max_row() {
        // Anchor near MAX_ROW; 3-row shape would extend past the
        // last valid Excel row.
        let mut t = SpillAnchorTable::new();
        let anchor = at(0, MAX_ROW - 1, 0);
        let err = t.register(anchor, SpillShape::new(3, 1)).unwrap_err();
        assert!(
            matches!(err, SpillBlockError::OutOfBounds { .. }),
            "got: {err:?}"
        );
        assert!(t.is_empty(), "table mutated on out-of-bounds reject");
    }

    #[test]
    fn register_rejects_spill_extending_past_max_column() {
        let mut t = SpillAnchorTable::new();
        let anchor = at(0, 0, MAX_COLUMN);
        let err = t.register(anchor, SpillShape::new(1, 2)).unwrap_err();
        assert!(matches!(err, SpillBlockError::OutOfBounds { .. }));
    }

    #[test]
    fn register_accepts_spill_ending_exactly_at_max_row() {
        // Last row of the spill == MAX_ROW exactly — should be allowed.
        let mut t = SpillAnchorTable::new();
        let anchor = at(0, MAX_ROW - 4, 0);
        t.register(anchor, SpillShape::new(5, 1)).unwrap();
        assert_eq!(t.anchor_at(0, MAX_ROW - 4, 0), Some(&SpillShape::new(5, 1)));
        assert_eq!(t.target_anchor(0, MAX_ROW, 0), Some(anchor));
    }

    #[test]
    fn register_rejects_u32_overflow_anchor_plus_shape() {
        // Anchor at u32::MAX; any non-1 shape would overflow checked_add.
        // (This is also out-of-bounds vs MAX_ROW, but the overflow path
        // is what we're proving here — checked_add returns None.)
        let mut t = SpillAnchorTable::new();
        let anchor = at(0, u32::MAX, 0);
        let err = t.register(anchor, SpillShape::new(2, 1)).unwrap_err();
        assert!(matches!(err, SpillBlockError::OutOfBounds { .. }));
    }
}
