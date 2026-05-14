//! Calc-graph node types — the four-variant `Node` enum that the dependency graph stores.
//!
//! Per spec Part V §4 Week 3 Days 1-3 + the Week 3 Day 0 reference deep-read
//! (`docs/phase0/references-reading-log.md`):
//! - `Cell` — a leaf node anchored at one `(sheet, row, col)`. The bulk of graph mass for any
//!   real workbook.
//! - `Range` — a compressed reference to a rectangle of cells. ONE node per distinct rectangle.
//!   `SUM(A:A)` produces one `Range` node, NOT one per cell (matches Formualizer's pattern at
//!   `engine/graph/range_deps.rs:36-192` + the spec's A4/A5 acceptance items).
//! - `FormulaRegion` — Quantbook-INVENTED, the highest Phase 0 risk per opus-arch audit. One
//!   node represents N cells that share an identical formula fingerprint. The A1 falsifier
//!   (Week 4) is the make-or-break test.
//! - `Spill` — shape-locked stub for Phase 3+ dynamic-array result anchors. Not constructed
//!   in Phase 0; included so adding it later isn't a breaking enum change.

use ql_formula_syntax::RangeRef;
use ql_types::{ColId, RowId, SheetId};

/// Identifier for a node within a single `Graph`. `u32` covers ~4.3 billion nodes — bigger
/// than any real workbook (`Excel max = MAX_ROW * MAX_COLUMN * sheet_count ≈ 1.7×10^10`,
/// but no real workbook approaches saturation).
///
/// Phase 0 reuses IDs only via the absence of a delete operation (the graph is append-only
/// in Week 3). Phase 3+ will add tombstone bits and an `is_active` accessor when row/column
/// deletion lands — mirroring Formualizer's `vertex_store.rs:418-426` pattern.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId(pub u32);

impl NodeId {
    pub fn index(self) -> usize {
        self.0 as usize
    }
}

/// A graph node.
///
/// The four-variant shape is locked to match the spec's node taxonomy + the deep-read's
/// adoption matrix. Each variant carries its own payload; the enum tag is the dispatch key
/// for visitors (dirty propagation, scheduler, snapshot accessors).
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Cell(CellNode),
    Range(RangeNode),
    FormulaRegion(FormulaRegionNode),
    Spill(SpillNode),
}

/// A single-cell leaf node anchored at `(sheet, row, col)`.
///
/// Phase 0 same-sheet only — `sheet` is `SheetId`, not `Option<SheetId>`, because every cell
/// belongs to exactly one sheet at construction time. Sheet-qualified formulas land in
/// Phase 3+; their `Expr::CellRef`s carry `Option<SheetId>` to indicate "the formula's
/// containing sheet" (resolved during binding into a concrete `SheetId` here).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CellNode {
    pub sheet: SheetId,
    pub row: RowId,
    pub col: ColId,
}

/// A compressed range-reference node — one node per distinct rectangle.
///
/// Per CORR-21 (the Week 3 Day 0 deep-read correction): registration uses the per-row /
/// per-column stripe pattern from Formualizer `engine/graph/range_deps.rs`, NOT
/// HyperFormula's prefix-tail. The `range` field captures the exact reference shape; the
/// stripe-index registration happens in `stripes.rs` (W3-5) consuming this same `RangeRef`.
///
/// `sheet` is the resolved `SheetId` (Phase 0 only same-sheet); `RangeRef` itself may still
/// carry `sheet: Option<SheetId>` from the AST — the graph constructor normalizes to a
/// concrete `SheetId` at add time.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct RangeNode {
    pub sheet: SheetId,
    pub range: RangeRef,
}

/// A formula region — Quantbook-INVENTED. Represents N cells in a `target_rect` rectangle
/// that all share an identical formula fingerprint. The classic example: column B has 25M
/// cells, each `=A_n * 2` for its own row index. Without this node, you get 25M individual
/// formula vertices; with it, you get one — provided the fingerprint matches.
///
/// `formula_fingerprint` is a u64 hash produced by `fingerprint.rs` (W3-4). `chunk_count` is
/// the count of `ql-storage::ColumnStore` chunks the region spans — kept here so the
/// scheduler can attribute work per-chunk without re-deriving from `target_rect` size.
///
/// **This is the highest-architectural-risk type in Phase 0.** The A1 falsifier (Week 4
/// Day 6) tests whether split/merge under 10K random single-cell edits stays <50ms total.
/// If it doesn't, FormulaRegionNode is the suspect.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct FormulaRegionNode {
    pub sheet: SheetId,
    pub target_start_row: RowId,
    pub target_start_col: ColId,
    pub target_end_row: RowId,
    pub target_end_col: ColId,
    pub formula_fingerprint: u64,
    pub chunk_count: u32,
}

/// Shape-locked stub for Phase 3+ spill anchors (dynamic-array results).
///
/// Not constructed in Phase 0 — every `add_spill_node` call panics with "Phase 3+ feature".
/// The shape is locked here so Phase 3 work doesn't break the `Node` enum; downstream
/// pattern matches that include `Node::Spill(_)` today can compile against the
/// not-yet-implemented variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SpillNode {
    pub anchor: NodeId,
    pub shape_rows: RowId,
    pub shape_cols: ColId,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_formula_syntax::SheetRef;

    #[test]
    fn node_id_index_is_u32_cast() {
        assert_eq!(NodeId(0).index(), 0);
        assert_eq!(NodeId(7).index(), 7);
        assert_eq!(NodeId(u32::MAX).index(), u32::MAX as usize);
    }

    #[test]
    fn cell_node_constructs_and_compares() {
        let a = CellNode {
            sheet: 0,
            row: 0,
            col: 0,
        };
        let b = CellNode {
            sheet: 0,
            row: 0,
            col: 0,
        };
        let c = CellNode {
            sheet: 0,
            row: 0,
            col: 1,
        };
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn range_node_constructs_with_whole_column() {
        let rn = RangeNode {
            sheet: 0,
            range: RangeRef::WholeColumn {
                sheet: SheetRef::Current,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
        };
        assert!(matches!(
            rn.range,
            RangeRef::WholeColumn { start_col: 0, .. }
        ));
    }

    #[test]
    fn formula_region_node_constructs() {
        let frn = FormulaRegionNode {
            sheet: 0,
            target_start_row: 0,
            target_start_col: 1,
            target_end_row: 999,
            target_end_col: 1,
            formula_fingerprint: 0xDEADBEEFCAFEBABE,
            chunk_count: 1,
        };
        assert_eq!(frn.formula_fingerprint, 0xDEADBEEFCAFEBABE);
        assert_eq!(frn.target_end_row - frn.target_start_row + 1, 1000);
    }

    #[test]
    fn spill_node_shape_locked() {
        let sn = SpillNode {
            anchor: NodeId(7),
            shape_rows: 3,
            shape_cols: 4,
        };
        assert_eq!(sn.anchor, NodeId(7));
        assert_eq!(sn.shape_rows, 3);
        assert_eq!(sn.shape_cols, 4);
    }

    #[test]
    fn node_enum_variants_are_distinguishable() {
        let c = Node::Cell(CellNode {
            sheet: 0,
            row: 0,
            col: 0,
        });
        let r = Node::Range(RangeNode {
            sheet: 0,
            range: RangeRef::WholeColumn {
                sheet: SheetRef::Current,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
        });
        assert!(matches!(c, Node::Cell(_)));
        assert!(matches!(r, Node::Range(_)));
        assert!(!matches!(r, Node::Cell(_)));
    }
}
