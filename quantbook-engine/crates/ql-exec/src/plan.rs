//! `ExprPlan` — execution-ready intermediate representation.
//!
//! Sits between `ql_formula_syntax::Expr` (parser output, may carry `Option<SheetId>` for
//! unresolved same-sheet refs) and the kernel dispatch in `scalar.rs` / `simd.rs` (W4-2).
//! `bind()` walks the Expr tree and resolves every `CellAddr.sheet: Option<SheetId>` to a
//! concrete `SheetId` based on the formula's owning sheet.
//!
//! The plan is "execution-ready" but still tree-shaped — it does NOT yet flatten the
//! expression into a SIMD-friendly opcode stream. That's the role of `kernel_simd` in W4-2,
//! which lowers `ExprPlan::Binary { op: Mul, lhs: CellRef, rhs: Number }` into a
//! `multiversion`-dispatched `Float64Array * f64` call.
//!
//! ## Phase 0 scope
//!
//! Subset of `Expr` variants covered:
//! - `Number(f64)` — numeric literal
//! - `Bool(bool)` — boolean literal
//! - `String(Arc<str>)` — text literal (binds 1:1)
//! - `CellRef { sheet, row, col, abs_col, abs_row }` — sheet RESOLVED to concrete SheetId
//! - `Binary { op, lhs, rhs }` — arithmetic + concat + comparison
//! - `Unary { op, operand }` — unary minus / plus / percent
//!
//! Deferred (will surface in W4-4 ql-functions integration):
//! - `RangeRef` — single range used inside a Function call (e.g. `SUM(A:A)`)
//! - `Function { name, args }` — registry dispatch
//! - `Array`, `Spill` — Phase 3+ dynamic arrays

use std::sync::Arc;

use ql_formula_syntax::{Expr, Operator};
use ql_types::{ColId, RowId, SheetId};

/// Bound, execution-ready expression. Sheet refs are concrete.
#[derive(Clone, Debug, PartialEq)]
pub enum ExprPlan {
    Number(f64),
    Bool(bool),
    String(Arc<str>),
    CellRef {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        abs_col: bool,
        abs_row: bool,
    },
    Binary {
        op: Operator,
        lhs: Box<ExprPlan>,
        rhs: Box<ExprPlan>,
    },
    Unary {
        op: Operator,
        operand: Box<ExprPlan>,
    },
}

/// Error during binding. Phase 0 has only one variant; future bind work (sheet-qualified
/// refs, named ranges) will add more.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BindError {
    /// The Expr contains a variant not supported in Phase 0 (e.g. RangeRef outside a
    /// Function context, Array literal, Spill anchor, named range).
    UnsupportedVariant(&'static str),
}

/// Resolve an Expr against an owning sheet, producing an ExprPlan.
///
/// `owning_sheet` is the sheet the formula lives on. AST `CellAddr.sheet` of `None` means
/// "this sheet"; `Some(s)` means an explicit sheet ref (Phase 3+ shipping the parser
/// surface; Phase 0 always has `None` from the lexer).
pub fn bind(expr: &Expr, owning_sheet: SheetId) -> Result<ExprPlan, BindError> {
    match expr {
        Expr::Number(n) => Ok(ExprPlan::Number(*n)),
        Expr::Bool(b) => Ok(ExprPlan::Bool(*b)),
        Expr::String(s) => Ok(ExprPlan::String(s.clone())),
        Expr::CellRef(addr) => Ok(ExprPlan::CellRef {
            sheet: addr.sheet.unwrap_or(owning_sheet),
            row: addr.row,
            col: addr.col,
            abs_col: addr.abs_col,
            abs_row: addr.abs_row,
        }),
        Expr::Binary { op, lhs, rhs } => Ok(ExprPlan::Binary {
            op: *op,
            lhs: Box::new(bind(lhs, owning_sheet)?),
            rhs: Box::new(bind(rhs, owning_sheet)?),
        }),
        Expr::Unary { op, operand } => Ok(ExprPlan::Unary {
            op: *op,
            operand: Box::new(bind(operand, owning_sheet)?),
        }),
        Expr::RangeRef(_) => Err(BindError::UnsupportedVariant(
            "RangeRef requires a Function context; Phase 0 W4-1 has no function dispatch yet",
        )),
        Expr::Function { .. } => Err(BindError::UnsupportedVariant(
            "Function dispatch lands in Phase 0 W4-4",
        )),
        Expr::Array(_) => Err(BindError::UnsupportedVariant("Array literals are Phase 3+")),
        Expr::Spill(_) => Err(BindError::UnsupportedVariant("Spill anchors are Phase 3+")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_formula_syntax::{CellAddr, RangeRef};

    #[test]
    fn bind_number() {
        let p = bind(&Expr::Number(42.5), 0).unwrap();
        assert_eq!(p, ExprPlan::Number(42.5));
    }

    #[test]
    fn bind_bool() {
        let p = bind(&Expr::Bool(true), 0).unwrap();
        assert_eq!(p, ExprPlan::Bool(true));
    }

    #[test]
    fn bind_cellref_unresolved_sheet_uses_owning() {
        let expr = Expr::CellRef(CellAddr {
            sheet: None,
            col: 3,
            row: 5,
            abs_col: false,
            abs_row: true,
        });
        let p = bind(&expr, 7).unwrap();
        assert_eq!(
            p,
            ExprPlan::CellRef {
                sheet: 7,
                row: 5,
                col: 3,
                abs_col: false,
                abs_row: true,
            }
        );
    }

    #[test]
    fn bind_cellref_resolved_sheet_kept() {
        // Phase 3+ scenario: `Sheet2!A1` from a formula on Sheet0 should bind to sheet 2.
        let expr = Expr::CellRef(CellAddr {
            sheet: Some(2),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        let p = bind(&expr, 0).unwrap();
        assert!(matches!(p, ExprPlan::CellRef { sheet: 2, .. }));
    }

    #[test]
    fn bind_binary_mul() {
        // =A1 * 2
        let expr = Expr::Binary {
            op: Operator::Mul,
            lhs: Box::new(Expr::CellRef(CellAddr {
                sheet: None,
                col: 0,
                row: 0,
                abs_col: false,
                abs_row: false,
            })),
            rhs: Box::new(Expr::Number(2.0)),
        };
        let p = bind(&expr, 0).unwrap();
        match p {
            ExprPlan::Binary {
                op: Operator::Mul,
                lhs,
                rhs,
            } => {
                assert!(matches!(*lhs, ExprPlan::CellRef { sheet: 0, .. }));
                assert_eq!(*rhs, ExprPlan::Number(2.0));
            }
            _ => panic!("expected Binary Mul"),
        }
    }

    #[test]
    fn bind_unary_minus() {
        let expr = Expr::Unary {
            op: Operator::Minus,
            operand: Box::new(Expr::Number(5.0)),
        };
        let p = bind(&expr, 0).unwrap();
        assert!(matches!(
            p,
            ExprPlan::Unary {
                op: Operator::Minus,
                ..
            }
        ));
    }

    #[test]
    fn bind_rangeref_unsupported() {
        let expr = Expr::RangeRef(RangeRef::WholeColumn {
            sheet: None,
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        });
        assert!(matches!(
            bind(&expr, 0),
            Err(BindError::UnsupportedVariant(_))
        ));
    }

    #[test]
    fn bind_function_unsupported_w4_1() {
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![],
        };
        assert!(matches!(
            bind(&expr, 0),
            Err(BindError::UnsupportedVariant(_))
        ));
    }
}
