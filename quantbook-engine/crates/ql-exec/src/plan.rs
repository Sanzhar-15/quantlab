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
    /// Function call. Args are bound recursively. Phase 0 W4-5: name is preserved
    /// verbatim from the AST (Excel-canonical uppercase normalization happens at the
    /// parser level — W4-5 expects already-uppercased names from the binder). The
    /// scalar evaluator looks up the name in a `FunctionRegistry` at evaluation time.
    Function {
        name: Arc<str>,
        args: Vec<ExprPlan>,
    },
}

/// Error during binding. Phase 2A.1 (2026-05-12) added `UnresolvedName` for the
/// new `Expr::NameRef` path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BindError {
    /// The Expr contains a variant not supported in this build (e.g. RangeRef
    /// outside a Function context, Array literal, Spill anchor, NamedTarget::Range
    /// — all Phase 4+ work).
    UnsupportedVariant(&'static str),
    /// A `NameRef` was used but the name isn't registered in the active `NameTable`.
    /// Phase 2A.1: equivalent to Excel's `#NAME?` but surfaced at bind time rather
    /// than as a runtime Error value, so the IDE can highlight the offending token
    /// before evaluation.
    UnresolvedName(Arc<str>),
}

/// Resolve an Expr against an owning sheet, producing an ExprPlan. **No name
/// resolution** — any `Expr::NameRef` produces `BindError::UnresolvedName`.
/// Callers that need named-range support should use `bind_with_names` and pass
/// a `&NameTable`.
///
/// `owning_sheet` is the sheet the formula lives on. AST `CellAddr.sheet` of `None`
/// means "this sheet"; `Some(s)` means an explicit sheet ref (Phase 3+ shipping the
/// parser surface; Phase 0/1 always has `None` from the lexer).
pub fn bind(expr: &Expr, owning_sheet: SheetId) -> Result<ExprPlan, BindError> {
    bind_with_names(expr, owning_sheet, &EmptyNameLookup)
}

/// Phase 2A.1 — bind with a name resolver. The resolver is any type implementing
/// `NameLookup`; the production caller passes a `ql_storage::NameTable` reference
/// (via the `NameLookup` blanket impl in `ql-exec::env`), but tests can supply
/// a custom HashMap-backed mock.
pub fn bind_with_names<L: NameLookup>(
    expr: &Expr,
    owning_sheet: SheetId,
    names: &L,
) -> Result<ExprPlan, BindError> {
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
            lhs: Box::new(bind_with_names(lhs, owning_sheet, names)?),
            rhs: Box::new(bind_with_names(rhs, owning_sheet, names)?),
        }),
        Expr::Unary { op, operand } => Ok(ExprPlan::Unary {
            op: *op,
            operand: Box::new(bind_with_names(operand, owning_sheet, names)?),
        }),
        Expr::RangeRef(_) => Err(BindError::UnsupportedVariant(
            "RangeRef requires a Function context; Phase 0 W4-1 has no function dispatch yet",
        )),
        Expr::Function { name, args } => {
            let mut bound_args = Vec::with_capacity(args.len());
            for a in args {
                bound_args.push(bind_with_names(a, owning_sheet, names)?);
            }
            Ok(ExprPlan::Function {
                name: name.clone(),
                args: bound_args,
            })
        }
        Expr::Array(_) => Err(BindError::UnsupportedVariant("Array literals are Phase 3+")),
        Expr::Spill(_) => Err(BindError::UnsupportedVariant("Spill anchors are Phase 3+")),
        Expr::NameRef(name) => {
            // Phase 2A.1: resolve the name via the active NameTable. The parser
            // canonicalized the name to uppercase; lookup is case-sensitive on that.
            match names.lookup_named_target(name) {
                Some(ResolvedName::Cell(sheet, row, col, abs_col, abs_row)) => {
                    Ok(ExprPlan::CellRef {
                        sheet,
                        row,
                        col,
                        abs_col,
                        abs_row,
                    })
                }
                Some(ResolvedName::Number(n)) => Ok(ExprPlan::Number(n)),
                Some(ResolvedName::Bool(b)) => Ok(ExprPlan::Bool(b)),
                Some(ResolvedName::Text(s)) => Ok(ExprPlan::String(s)),
                Some(ResolvedName::Range) => Err(BindError::UnsupportedVariant(
                    "NamedTarget::Range resolution requires the Phase 4+ FormulaRegion binder",
                )),
                Some(ResolvedName::Formula) => Err(BindError::UnsupportedVariant(
                    "NamedTarget::Formula resolution requires the Phase 3+ ql-formula-semantics layer",
                )),
                None => Err(BindError::UnresolvedName(name.clone())),
            }
        }
    }
}

/// Variant describing a resolved name's target, mapped from `ql_storage::NamedTarget`.
/// Phase 2A.1: this is the binder's intermediate vocabulary — the binder doesn't
/// import ql-storage directly, so the lookup trait projects NamedTarget into this
/// enum first. Phase 2 supports Cell + Constant; Range and Formula return
/// unsupported errors.
#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedName {
    Cell(SheetId, RowId, ColId, bool, bool),
    Number(f64),
    Bool(bool),
    Text(Arc<str>),
    Range,
    Formula,
}

/// Name-resolution interface. ql-exec stays decoupled from ql-storage; the
/// production caller wires a NameTable through this trait.
pub trait NameLookup {
    fn lookup_named_target(&self, name: &str) -> Option<ResolvedName>;
}

/// Default empty-lookup resolver used by the legacy `bind()` entry point. Always
/// returns `None`, so any NameRef becomes `BindError::UnresolvedName`.
struct EmptyNameLookup;

impl NameLookup for EmptyNameLookup {
    fn lookup_named_target(&self, _name: &str) -> Option<ResolvedName> {
        None
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
    fn bind_function_lands_in_w4_5() {
        // Per W4-5: Function variant binds successfully; name + args preserved verbatim.
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![Expr::Number(1.0), Expr::Number(2.0)],
        };
        let p = bind(&expr, 0).unwrap();
        match p {
            ExprPlan::Function { name, args } => {
                assert_eq!(name.as_ref(), "SUM");
                assert_eq!(args.len(), 2);
                assert_eq!(args[0], ExprPlan::Number(1.0));
                assert_eq!(args[1], ExprPlan::Number(2.0));
            }
            _ => panic!("expected Function"),
        }
    }

    #[test]
    fn bind_function_with_nested_cellref() {
        // =SUM(A1, A2) — both args resolve to CellRefs on the owning sheet.
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![
                Expr::CellRef(CellAddr {
                    sheet: None,
                    col: 0,
                    row: 0,
                    abs_col: false,
                    abs_row: false,
                }),
                Expr::CellRef(CellAddr {
                    sheet: None,
                    col: 0,
                    row: 1,
                    abs_col: false,
                    abs_row: false,
                }),
            ],
        };
        let p = bind(&expr, 7).unwrap();
        match p {
            ExprPlan::Function { args, .. } => {
                assert!(matches!(
                    args[0],
                    ExprPlan::CellRef {
                        sheet: 7,
                        row: 0,
                        col: 0,
                        ..
                    }
                ));
                assert!(matches!(
                    args[1],
                    ExprPlan::CellRef {
                        sheet: 7,
                        row: 1,
                        col: 0,
                        ..
                    }
                ));
            }
            _ => panic!(),
        }
    }
}
