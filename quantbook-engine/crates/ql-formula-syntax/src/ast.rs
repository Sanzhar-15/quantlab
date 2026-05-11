//! Abstract Syntax Tree node definitions.
//!
//! Per spec Part V §4 Week 2 Days 5-6. **THIS COMMIT SHIPS TYPE DEFINITIONS ONLY** — the
//! Pratt parser that constructs these nodes is intentionally deferred to a fresh session
//! per the opus-architecture audit finding #9 ("the parser is the 2-3 day item; ship in a
//! focused block with reference reading done first").
//!
//! The shape locks here are deliberately complete (matches `_QUANTBOOK-MASTER-PLAN.md` §6.3
//! AST list: "Number, String, Bool, Ref, Range, BinaryOp, UnaryOp, Function, Array, Spill")
//! so future commits add parser logic without re-shaping the AST.

use std::sync::Arc;

use ql_types::{ColId, RowId};

use crate::token::Operator;

/// A formula expression. Tree-shaped — children are `Box<Expr>` to keep node size bounded.
#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    /// Numeric literal (already coerced to f64; lexer rejects NaN/Inf).
    Number(f64),

    /// String literal (interior content; quotes stripped).
    String(Arc<str>),

    /// Boolean literal `TRUE` / `FALSE` (parser recognizes these as keywords when they appear
    /// as bare identifiers).
    Bool(bool),

    /// Cell reference. Sheet-qualification is deferred; Phase 0 only supports same-sheet refs.
    CellRef(CellAddr),

    /// Range reference (rectangular, inclusive). Includes whole-column / whole-row forms
    /// via the `start`/`end` shape — when `start.row.is_none()` or `end.row.is_none()`, the
    /// range spans the full column axis. Same idea for cols.
    RangeRef(RangeRef),

    /// Binary operator application.
    Binary {
        op: Operator,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },

    /// Unary operator application (`-x`, `+x`, `x%`).
    Unary { op: Operator, operand: Box<Expr> },

    /// Function call. `name` is the function identifier (e.g. `"SUM"`); the parser uppercases
    /// it for canonical comparison. Per CORR-06 / T4-D05: the parser builds `Function { name:
    /// "AI", args: ... }` for any `AI(...)` source; the binder/evaluator then maps the call to
    /// `Error(ErrorValue::AINotAvailable)`. AI is NOT a lexer-level keyword — see token.rs
    /// module doc for the source-text propagation contract.
    Function { name: Arc<str>, args: Vec<Expr> },

    /// Array literal `{1,2;3,4}`. Phase 0 lexer doesn't recognize `{` — this variant is
    /// shape-locked for Phase 3+ dynamic-array work.
    Array(Vec<Vec<Expr>>),

    /// Spill anchor — Phase 3+ dynamic-array result anchor. Shape-locked, not constructed
    /// in Phase 0.
    Spill(Box<Expr>),
}

/// Address inside an `Expr` — sheet-qualification deferred to Phase 3+; `sheet: None` means
/// "the formula's containing sheet" (resolved during binding).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CellAddr {
    pub col: ColId,
    pub row: RowId,
    pub abs_col: bool,
    pub abs_row: bool,
}

/// Range reference inside an `Expr` — validated enum shape.
///
/// Per codex r13 N3: the prior `RangeRef` was an option-field bag where all-`None` and
/// other ill-formed combinations were constructible. Amendment A4's structural graph-dump
/// assertions explicitly need `SUM(A:A)` to compress to ONE whole-column variant. The
/// option-bag couldn't pattern-match on "is this a whole-column range?" cleanly.
///
/// Three valid forms (matches Excel-canonical range types; sheet-qualification deferred):
///   - `Cells { ... }` — bounded rectangular range `A1:B10`
///   - `WholeColumn { ... }` — `A:A`, `A:C`, `$A:$D` (cols specified; rows are the full sheet)
///   - `WholeRow { ... }` — `1:1`, `2:5`, `$3:$3` (rows specified; cols are the full sheet)
///
/// Same-sheet only in Phase 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RangeRef {
    /// Bounded rectangular cell range. Start ≤ end on each axis (parser-normalized).
    Cells {
        start_col: ColId,
        start_row: RowId,
        end_col: ColId,
        end_row: RowId,
        abs_start_col: bool,
        abs_start_row: bool,
        abs_end_col: bool,
        abs_end_row: bool,
    },
    /// Whole-column range (e.g. `A:A`, `B:D`). Rows span the full sheet.
    WholeColumn {
        start_col: ColId,
        end_col: ColId,
        abs_start: bool,
        abs_end: bool,
    },
    /// Whole-row range (e.g. `1:1`, `2:5`). Cols span the full sheet.
    WholeRow {
        start_row: RowId,
        end_row: RowId,
        abs_start: bool,
        abs_end: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expr_simple_constructors_compile() {
        let _ = Expr::Number(1.5);
        let _ = Expr::String(Arc::from("hi"));
        let _ = Expr::Bool(true);
        let _ = Expr::CellRef(CellAddr {
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
    }

    #[test]
    fn expr_binary_construction() {
        // 1 + 2
        let one_plus_two = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(Expr::Number(1.0)),
            rhs: Box::new(Expr::Number(2.0)),
        };
        match one_plus_two {
            Expr::Binary { op, .. } => assert_eq!(op, Operator::Plus),
            _ => panic!(),
        }
    }

    #[test]
    fn expr_function_construction() {
        // SUM(A1, A2)
        let sum = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![
                Expr::CellRef(CellAddr {
                    col: 0,
                    row: 0,
                    abs_col: false,
                    abs_row: false,
                }),
                Expr::CellRef(CellAddr {
                    col: 0,
                    row: 1,
                    abs_col: false,
                    abs_row: false,
                }),
            ],
        };
        if let Expr::Function { args, .. } = sum {
            assert_eq!(args.len(), 2);
        } else {
            panic!();
        }
    }

    #[test]
    fn rangeref_whole_column_shape() {
        // A:A — explicit WholeColumn variant.
        let r = RangeRef::WholeColumn {
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        };
        assert!(matches!(
            r,
            RangeRef::WholeColumn {
                start_col: 0,
                end_col: 0,
                ..
            }
        ));
    }

    #[test]
    fn rangeref_whole_row_shape() {
        let r = RangeRef::WholeRow {
            start_row: 0,
            end_row: 0,
            abs_start: false,
            abs_end: false,
        };
        assert!(matches!(
            r,
            RangeRef::WholeRow {
                start_row: 0,
                end_row: 0,
                ..
            }
        ));
    }

    #[test]
    fn rangeref_cells_bounded_shape() {
        let r = RangeRef::Cells {
            start_col: 0,
            start_row: 0,
            end_col: 1,
            end_row: 9,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        };
        assert!(matches!(
            r,
            RangeRef::Cells {
                end_row: 9,
                end_col: 1,
                ..
            }
        ));
    }

    #[test]
    fn rangeref_variants_distinct() {
        let cells = RangeRef::Cells {
            start_col: 0,
            start_row: 0,
            end_col: 0,
            end_row: 0,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        };
        let col = RangeRef::WholeColumn {
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        };
        let row = RangeRef::WholeRow {
            start_row: 0,
            end_row: 0,
            abs_start: false,
            abs_end: false,
        };
        assert_ne!(cells, col);
        assert_ne!(cells, row);
        assert_ne!(col, row);
    }

    #[test]
    fn expr_structural_equality() {
        let a = Expr::Number(1.5);
        let b = Expr::Number(1.5);
        assert_eq!(a, b);
        let c = Expr::Number(2.5);
        assert_ne!(a, c);
    }
}
