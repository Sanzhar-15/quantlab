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
use ql_types::{ColId, ErrorValue, Range, RowId, SheetId};

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
    /// Phase 2B.4 (2026-05-12): a `NameRef` resolving to a `NamedTarget::Range`
    /// in an aggregate-argument position (e.g. the arg of `SUM`, `AVERAGE`,
    /// `COUNT`). Carries the canonical name + the resolved Range. The scalar
    /// evaluator currently rejects this with `Value::Error(ErrorValue::Calc)`
    /// because aggregate-range evaluation is Engine Phase 3.6 work; the bind
    /// shape lands now so the IDE / op-log surfaces are stable when Phase 3.6
    /// flips the eval on.
    ///
    /// In scalar (non-aggregate) positions, the same `NameRef` produces
    /// [`BindError::NamedRangeInScalarContext`] instead of binding to this
    /// variant.
    AggregateNameRef {
        /// Canonical (uppercase) name as it appears in the NameTable.
        name: Arc<str>,
        /// Pre-resolved range payload. Phase 3.6 evaluator reads from this
        /// directly rather than re-looking-up the name.
        range: Range,
    },
}

/// Error during binding. Phase 2A.1 added `UnresolvedName`; Phase 2A.6 added
/// `NamedTargetIs{Blank,Error}`; Phase 2A.11 audit M16 switched to
/// `thiserror::Error` for consistency with the rest of the error surface.
/// Display strings are now user-facing (suitable for IDE diagnostics).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum BindError {
    /// The Expr contains a variant not supported in this build (e.g. RangeRef
    /// outside a Function context, Array literal, Spill anchor, NamedTarget::Range
    /// — all Engine Phase 4 work per `docs/MASTER-PLAN.md`).
    #[error("unsupported expression variant: {0}")]
    UnsupportedVariant(&'static str),
    /// A `NameRef` was used but the name isn't registered in the active `NameTable`.
    /// Phase 2A.1: equivalent to Excel's `#NAME?` but surfaced at bind time rather
    /// than as a runtime Error value, so the IDE can highlight the offending token
    /// before evaluation.
    #[error("unresolved name {0:?}")]
    UnresolvedName(Arc<str>),
    /// A `NameRef` resolved to a `NamedTarget::Constant(Value::Blank)`. Phase 2A.6
    /// audit M2: previously this was silently coerced to `Text("")`, producing
    /// nonsense in arithmetic contexts. Now surfaced loudly so callers fix the
    /// data binding.
    #[error("named constant {0:?} is blank; cannot be used in this context")]
    NamedTargetIsBlank(Arc<str>),
    /// A `NameRef` resolved to a `NamedTarget::Constant(Value::Error(_))`. Phase 2A.6
    /// audit M3: previously silently mapped to `UnresolvedName` (wrong error class —
    /// the name IS resolved, just to an error value). Carries the underlying
    /// `ErrorValue` so the IDE can echo `#DIV/0!` / `#REF!` etc. accurately.
    // Phase 2A.13 audit cycle-3 M1: `{1}` (Display) instead of `{1:?}` (Debug).
    // `ErrorValue` has a `Display` impl that renders the canonical Excel sigil
    // (`#DIV/0!` etc.); the prior debug formatter leaked Rust enum identifiers
    // ("DivZero") into IDE diagnostics — the same mistake WS-4 was supposed to
    // close everywhere. Note `{0:?}` is kept deliberately on the name field
    // so the Arc<str> is rendered with surrounding quotes for visual clarity
    // ("named constant \"X\" ..." vs the bare-string ambiguous "named constant X").
    #[error("named constant {0:?} holds an error value: {1}")]
    NamedTargetIsError(Arc<str>, ErrorValue),
    /// Phase 2B.4 (2026-05-12): a `NameRef` resolving to a `NamedTarget::Range`
    /// appeared in a scalar-context position (e.g. `=Sales + 1` instead of
    /// `=SUM(Sales)`). Excel returns `#VALUE!` at evaluation; we surface it at
    /// bind so the IDE highlights the offending token before any state writes.
    /// Distinct from the generic `UnsupportedVariant` so callers can render a
    /// specific "this name is a range; use it inside an aggregate function"
    /// hint.
    #[error(
        "named range {0:?} cannot be used in this scalar position; \
         wrap it in an aggregate function such as SUM, AVERAGE, COUNT, MIN, MAX"
    )]
    NamedRangeInScalarContext(Arc<str>),
    /// Phase 2B.4 (2026-05-12): a `NameRef` resolving to a
    /// `NamedTarget::Formula` in a scalar-context position. Named formulas
    /// (`Profit = Revenue - Costs`) are Engine Phase 4 work; this distinct
    /// variant tells the IDE / caller that the name is recognized but the
    /// named-formula feature itself is not yet shipped.
    #[error(
        "named formula {0:?} cannot be used in this position; \
         named-formula resolution is Engine Phase 4 work"
    )]
    NamedFormulaUnsupported(Arc<str>),
}

/// Phase 2B.4 (2026-05-12): bind-time context for a sub-expression. Drives
/// per-name-ref decisions about whether a `NamedTarget::Range` is acceptable
/// (aggregate-arg) or surfaces as `BindError::NamedRangeInScalarContext`
/// (scalar). Internal to the binder; not exposed in the public API yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BindContext {
    /// Default. NameRefs resolving to ranges or formulas are rejected with
    /// precise errors.
    Scalar,
    /// Inside the argument list of an aggregate function (SUM, AVERAGE,
    /// MIN, MAX, COUNT, etc. — see `is_aggregate_function`). NameRefs
    /// resolving to ranges bind to `ExprPlan::AggregateNameRef`; named
    /// formulas still error (Engine Phase 4 work).
    AggregateArg,
}

/// Phase 2B.4 (2026-05-12): hardcoded list of functions whose arguments
/// accept aggregate-range / named-range inputs. The function name is
/// historical — this list is now better understood as "names for which
/// the binder allows `AggregateNameRef` in arg positions"; both scalar
/// aggregates (SUM, AVERAGE) AND range-aware functions (SUMIF, VLOOKUP,
/// LARGE, ...) live here. The `is_aggregate_function_lists_only_registered_aggregates`
/// test invariant pins the cross-table sync.
///
/// **Re-target:** the planned replacement with per-function metadata
/// (`FunctionRegistry` attributes) is no longer Phase 4.3 work — Phase
/// 4.3 wave 1 closed W5-58 with this matcher still in place. The right
/// time to replace this is **Phase 4.7 (array formulas) or Phase 4.10
/// (function library wave 2)**, whichever introduces richer per-
/// function metadata first.
///
/// Aggregate detection is binary in V0 (all args are aggregate or no args
/// are). Per-arg-position decisions (e.g. IF's then/else accept arrays in
/// some contexts) land alongside Engine Phase 4.7 array formulas.
pub(crate) fn is_aggregate_function(name: &str) -> bool {
    // Phase 2B.7 audit (correctness M1): MEDIAN removed — it was listed
    // here but not registered in `ql_functions::default_registry`. Keeping
    // the list synced with the registry is a hard rule; the
    // `is_aggregate_function_lists_only_registered_aggregates` test pins
    // it. When Engine Phase 4.3 expands the function library, the metadata
    // moves to per-function FunctionRegistry attributes and this hardcoded
    // matcher goes away entirely.
    //
    // W5-53 (GAP-F-05 closure): SUMIF + COUNTIF are NOT scalar aggregates
    // (they return a scalar but take range + criteria) — they live in the
    // parallel `range_aware_fns` table. But the binder uses this list to
    // decide whether `NamedRangeInScalarContext` should fire on
    // `=SUMIF(NamedRange, 5)`. Since SUMIF NEEDS a range arg, we add it
    // here so the binder allows the AggregateNameRef in arg position. The
    // eval-side dispatch routes correctly via `lookup_range_aware` first.
    matches!(
        name,
        "SUM"
            | "AVERAGE"
            | "AVG"
            | "COUNT"
            | "COUNTA"
            | "MIN"
            | "MAX"
            | "PRODUCT"
            | "VAR"
            | "VAR.S"
            | "VAR.P"
            | "STDEV"
            | "STDEV.S"
            | "STDEV.P"
            // Range-aware (W5-53): NOT scalar aggregates, but the binder
            // treats them as aggregate-context for arg binding so named-
            // range args resolve to `AggregateNameRef`.
            | "SUMIF"
            | "COUNTIF"
            // Range-aware lookup family (W5-54): same reason — table
            // args are range references that must bind as
            // AggregateNameRef so the eval-side dispatch can construct
            // `FnArg::Range { values, rows, cols }`.
            | "MATCH"
            | "INDEX"
            | "VLOOKUP"
            | "HLOOKUP"
            | "CHOOSE"
            // Range-aware conditional-aggregate completion (W5-55).
            | "AVERAGEIF"
            | "SUMIFS"
            | "COUNTIFS"
            | "AVERAGEIFS"
            | "SUMPRODUCT"
            // Range-aware stats family (W5-58, FN4-01 closure).
            | "LARGE"
            | "SMALL"
            | "RANK"
            | "RANK.EQ"
            | "RANK.AVG"
            | "MEDIAN"
            | "MODE"
            | "MODE.SNGL"
            // Range-aware text completion (W5-61 polish).
            | "CONCAT"
    )
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
///
/// Phase 2B.4 (2026-05-12): the top-level entry point binds in
/// [`BindContext::Scalar`]. Recursion into aggregate-function arg lists
/// switches to [`BindContext::AggregateArg`].
pub fn bind_with_names<L: NameLookup>(
    expr: &Expr,
    owning_sheet: SheetId,
    names: &L,
) -> Result<ExprPlan, BindError> {
    bind_with_context(expr, owning_sheet, names, BindContext::Scalar)
}

fn bind_with_context<L: NameLookup>(
    expr: &Expr,
    owning_sheet: SheetId,
    names: &L,
    ctx: BindContext,
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
            // Binary operands are always scalar context regardless of the
            // outer context (Excel doesn't accept `=SUM(A1 + B1:B10)` —
            // each operand to + is scalar).
            lhs: Box::new(bind_with_context(
                lhs,
                owning_sheet,
                names,
                BindContext::Scalar,
            )?),
            rhs: Box::new(bind_with_context(
                rhs,
                owning_sheet,
                names,
                BindContext::Scalar,
            )?),
        }),
        Expr::Unary { op, operand } => Ok(ExprPlan::Unary {
            op: *op,
            operand: Box::new(bind_with_context(
                operand,
                owning_sheet,
                names,
                BindContext::Scalar,
            )?),
        }),
        Expr::RangeRef(_) => Err(BindError::UnsupportedVariant(
            "RangeRef requires a Function context; Phase 0 W4-1 has no function dispatch yet",
        )),
        Expr::Function { name, args } => {
            // Phase 2B.4: switch context for aggregate-function arg lists.
            let arg_ctx = if is_aggregate_function(name) {
                BindContext::AggregateArg
            } else {
                BindContext::Scalar
            };
            let mut bound_args = Vec::with_capacity(args.len());
            for a in args {
                bound_args.push(bind_with_context(a, owning_sheet, names, arg_ctx)?);
            }
            Ok(ExprPlan::Function {
                name: name.clone(),
                args: bound_args,
            })
        }
        Expr::Array(_) => Err(BindError::UnsupportedVariant("Array literals are Phase 3+")),
        Expr::Spill(_) => Err(BindError::UnsupportedVariant("Spill anchors are Phase 3+")),
        Expr::NameRef(name) => {
            // Phase 2A.6 audit M1: parser-emitted `NameRef` must always carry a
            // non-empty canonical name. An empty name here means the parser is
            // broken; panic to surface the upstream bug per the no-fallbacks rule.
            assert!(
                !name.is_empty(),
                "bind_with_context: Expr::NameRef carries an empty string — parser invariant violated"
            );
            // Phase 2A.1: resolve the name via the active NameTable; Phase 2A.6
            // audit H2 uses case-insensitive lookup in the `NameTable` impl so
            // every entry point canonicalizes uniformly.
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
                // Phase 2B.4: context-aware Range handling.
                Some(ResolvedName::Range(range)) => match ctx {
                    BindContext::AggregateArg => Ok(ExprPlan::AggregateNameRef {
                        name: name.clone(),
                        range,
                    }),
                    BindContext::Scalar => Err(BindError::NamedRangeInScalarContext(name.clone())),
                },
                // Phase 2B.4: named formulas still unsupported (Engine Phase 4).
                // We surface a distinct error rather than the generic
                // UnsupportedVariant so the IDE can render a specific hint.
                Some(ResolvedName::Formula(_)) => {
                    Err(BindError::NamedFormulaUnsupported(name.clone()))
                }
                // Phase 2A.6 audit M2/M3: surface Blank- and Error-targets loudly.
                Some(ResolvedName::Blank) => Err(BindError::NamedTargetIsBlank(name.clone())),
                Some(ResolvedName::ErrorValue(e)) => {
                    Err(BindError::NamedTargetIsError(name.clone(), e))
                }
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
///
/// Phase 2A.6 audit M2/M3: added `Blank` and `ErrorValue` so the binder can
/// surface them as distinct `BindError` variants instead of either coercing
/// silently or returning the wrong error class.
#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedName {
    Cell(SheetId, RowId, ColId, bool, bool),
    Number(f64),
    Bool(bool),
    Text(Arc<str>),
    /// `NamedTarget::Range(_)` resolved with payload. Phase 2B.4 (2026-05-12):
    /// previously carried no data; now threads the underlying `Range` so the
    /// binder can pre-resolve into `ExprPlan::AggregateNameRef` without
    /// asking the name table again at eval time.
    Range(Range),
    /// `NamedTarget::Formula(_)` resolved with payload. Phase 2B.4 added the
    /// formula text payload; the binder rejects this for now (named-formula
    /// resolution is Engine Phase 4) but the shape is in place.
    Formula(Arc<str>),
    /// `NamedTarget::Constant(Value::Blank)`. The binder rejects this loudly so
    /// the caller can fix the data binding.
    Blank,
    /// `NamedTarget::Constant(Value::Error(...))`. The binder rejects with a
    /// distinct error carrying the underlying `ErrorValue`.
    ErrorValue(ErrorValue),
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
