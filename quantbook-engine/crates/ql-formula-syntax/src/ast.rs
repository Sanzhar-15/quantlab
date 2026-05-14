//! Abstract Syntax Tree node definitions.
//!
//! Per spec Part V §4 Week 2 Days 5-6. The AST shapes lock the parser's output
//! vocabulary and the binder's input vocabulary; the Phase 1 W5-1 Pratt parser
//! builds these trees, the Phase 1 W5-2 printer round-trips them, and the
//! Phase 0 W4-1 binder in `ql-exec::plan` lowers them to `ExprPlan`.
//!
//! Phase 2A.1 (2026-05-12) added the `NameRef(Arc<str>)` variant for
//! defined-name references; the binder resolves it via the workbook's
//! `NameTable` at bind time.
//!
//! AST list aligned with `_QUANTBOOK-MASTER-PLAN.md` §6.3: Number, String,
//! Bool, CellRef, RangeRef, Binary, Unary, Function, Array, Spill, NameRef.
//! `Array` and `Spill` are reserved for Phase 3+ dynamic-array work; the
//! binder rejects them with `BindError::UnsupportedVariant`.

use std::sync::Arc;

use ql_types::{ColId, RowId, SheetId};

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

    /// Defined-name reference (Phase 2A.1). Parser emits this for any bare identifier
    /// (4+ letter) that isn't `TRUE`/`FALSE` or followed by `LParen`. The binder
    /// resolves the name against the `NameTable` at bind time:
    /// - `NamedTarget::Cell(addr)` → `ExprPlan::CellRef`
    /// - `NamedTarget::Constant(value)` → matching literal `ExprPlan` variant
    /// - `NamedTarget::Range(range)` → unsupported in Phase 2 (Phase 4+ region binder)
    /// - `NamedTarget::Formula(text)` → unsupported in Phase 2 (Phase 3+ semantic layer)
    /// - Not found → `BindError::UnresolvedName`
    ///
    /// `name` is the canonical (uppercased) form as the parser stored it. NameTable
    /// lookup is case-sensitive on this canonical form; the parser owns case-folding.
    NameRef(Arc<str>),

    /// **W5-98 (Phase 4.7.D):** error-sigil literal — `#REF!`, `#N/A`,
    /// `#DIV/0!`, etc. Emitted by the parser when `Token::Error(ev)` is
    /// encountered as a primary expression. The binder lowers to
    /// `ExprPlan::String(_)` (or a dedicated `ExprPlan::Error` variant
    /// — final shape lands in W5-100 / 4.7.F). At evaluation time the
    /// value is `Value::Error(ev)`.
    ///
    /// Common use sites:
    /// - `=#REF!` — a formula that simply evaluates to the error.
    /// - `=IFERROR(SOMETHING(), #N/A)` — explicit error fallback.
    /// - `{1, #N/A, 3}` — error literal in an array (per Phase 4.7
    ///   design § 3.3).
    Error(ql_types::ErrorValue),
}

/// **W5-87 (Phase 4.6.A part 1):** sheet-qualification for AST references.
///
/// - `Current` — formula's owning sheet (no `Sheet!` prefix in source).
///   The historical `Option::None` value maps here.
/// - `Name(Arc<str>)` — parser-emitted name for `Sheet!X` and `'Sheet'!X`
///   syntax. Binder resolves to `Id` via `SheetResolver` (Phase 4.6.B).
/// - `Id(SheetId)` — already-resolved sheet id (the historical
///   `Option::Some(id)` value, plus what the binder produces after
///   resolving `Name`).
///
/// Per design doc § 5.2 / Codex HIGH-3 fix: parser stays workbook-free
/// by emitting `Name`; resolution happens at bind time. Tests + post-
/// bind code construct `Id` directly.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum SheetRef {
    /// No `Sheet!` prefix in source — defaults to the formula's owning sheet.
    Current,
    /// Unresolved sheet name from the lexer. Resolved at bind time.
    Name(Arc<str>),
    /// Resolved sheet id. Produced post-bind or by tests bypassing the binder.
    Id(SheetId),
}

impl SheetRef {
    /// Backwards-compat helper for the Phase 4.6.A migration: the
    /// historical `Option<SheetId>::None` value maps to `Current`,
    /// `Some(id)` maps to `Id(id)`. Lets call sites that were
    /// constructing `Option<SheetId>` switch with minimal churn.
    pub fn from_option(opt: Option<SheetId>) -> Self {
        match opt {
            None => Self::Current,
            Some(id) => Self::Id(id),
        }
    }

    /// **W5-87 (Phase 4.6.A part 1):** resolve against a default sheet
    /// (typically the formula's owning sheet). Mirrors the historical
    /// `Option<SheetId>::unwrap_or(owning_sheet)` pattern. PANICS on
    /// `SheetRef::Name`: that variant is parser-only, and any post-
    /// parse code path should have resolved it through the binder
    /// before reaching layers that call this method (calcgraph,
    /// stripes, etc.).
    pub fn resolve_or(&self, owning_sheet: SheetId) -> SheetId {
        match self {
            SheetRef::Current => owning_sheet,
            SheetRef::Id(s) => *s,
            SheetRef::Name(name) => panic!(
                "unresolved SheetRef::Name({name:?}) at a layer that requires \
                 a resolved sheet id — must go through the binder first"
            ),
        }
    }

    /// **W5-87 (Phase 4.6.A part 1):** if already resolved to an id,
    /// return it; if `Current`, return None (caller decides what
    /// default to use). Used by code paths that DON'T have an owning-
    /// sheet context handy.
    pub fn id(&self) -> Option<SheetId> {
        match self {
            SheetRef::Current => None,
            SheetRef::Id(s) => Some(*s),
            SheetRef::Name(_) => None,
        }
    }
}

/// **W5-91 (Phase 4.6.C):** recursively rewrite every `SheetRef::Name`
/// in `expr` whose canonical form (ASCII uppercase) matches
/// `old_canonical` to `SheetRef::Name(new_name)`. Used by
/// `WorkbookRuntime::rename_sheet` to update stored formula text
/// after a sheet rename, via a parse → rewrite → print round trip.
///
/// Returns a new Expr; the input is not mutated. `Current` and `Id`
/// sheet refs pass through unchanged. Non-matching `Name` entries
/// also pass through.
pub fn rewrite_sheet_name_in_expr(expr: &Expr, old_canonical: &str, new_name: &Arc<str>) -> Expr {
    match expr {
        Expr::Number(n) => Expr::Number(*n),
        Expr::String(s) => Expr::String(s.clone()),
        Expr::Bool(b) => Expr::Bool(*b),
        Expr::NameRef(n) => Expr::NameRef(n.clone()),
        Expr::Error(ev) => Expr::Error(*ev),
        Expr::CellRef(addr) => Expr::CellRef(CellAddr {
            sheet: rewrite_sheet_ref(&addr.sheet, old_canonical, new_name),
            col: addr.col,
            row: addr.row,
            abs_col: addr.abs_col,
            abs_row: addr.abs_row,
        }),
        Expr::RangeRef(r) => Expr::RangeRef(rewrite_range_ref(r, old_canonical, new_name)),
        Expr::Binary { op, lhs, rhs } => Expr::Binary {
            op: *op,
            lhs: Box::new(rewrite_sheet_name_in_expr(lhs, old_canonical, new_name)),
            rhs: Box::new(rewrite_sheet_name_in_expr(rhs, old_canonical, new_name)),
        },
        Expr::Unary { op, operand } => Expr::Unary {
            op: *op,
            operand: Box::new(rewrite_sheet_name_in_expr(operand, old_canonical, new_name)),
        },
        Expr::Function { name, args } => Expr::Function {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| rewrite_sheet_name_in_expr(a, old_canonical, new_name))
                .collect(),
        },
        Expr::Array(rows) => Expr::Array(
            rows.iter()
                .map(|row| {
                    row.iter()
                        .map(|cell| rewrite_sheet_name_in_expr(cell, old_canonical, new_name))
                        .collect()
                })
                .collect(),
        ),
        Expr::Spill(inner) => Expr::Spill(Box::new(rewrite_sheet_name_in_expr(
            inner,
            old_canonical,
            new_name,
        ))),
    }
}

fn rewrite_sheet_ref(sheet: &SheetRef, old_canonical: &str, new_name: &Arc<str>) -> SheetRef {
    match sheet {
        SheetRef::Name(n) if n.eq_ignore_ascii_case(old_canonical) => {
            SheetRef::Name(new_name.clone())
        }
        other => other.clone(),
    }
}

fn rewrite_range_ref(r: &RangeRef, old_canonical: &str, new_name: &Arc<str>) -> RangeRef {
    match r {
        RangeRef::Cells {
            sheet,
            start_col,
            start_row,
            end_col,
            end_row,
            abs_start_col,
            abs_start_row,
            abs_end_col,
            abs_end_row,
        } => RangeRef::Cells {
            sheet: rewrite_sheet_ref(sheet, old_canonical, new_name),
            start_col: *start_col,
            start_row: *start_row,
            end_col: *end_col,
            end_row: *end_row,
            abs_start_col: *abs_start_col,
            abs_start_row: *abs_start_row,
            abs_end_col: *abs_end_col,
            abs_end_row: *abs_end_row,
        },
        RangeRef::WholeColumn {
            sheet,
            start_col,
            end_col,
            abs_start,
            abs_end,
        } => RangeRef::WholeColumn {
            sheet: rewrite_sheet_ref(sheet, old_canonical, new_name),
            start_col: *start_col,
            end_col: *end_col,
            abs_start: *abs_start,
            abs_end: *abs_end,
        },
        RangeRef::WholeRow {
            sheet,
            start_row,
            end_row,
            abs_start,
            abs_end,
        } => RangeRef::WholeRow {
            sheet: rewrite_sheet_ref(sheet, old_canonical, new_name),
            start_row: *start_row,
            end_row: *end_row,
            abs_start: *abs_start,
            abs_end: *abs_end,
        },
    }
}

/// Address inside an `Expr`. `sheet: SheetRef::Current` means "the
/// formula's containing sheet" (resolved during binding). Sheet-
/// qualified refs (`Sheet1!A1`, `'Q3 2025'!A1`) populate
/// `SheetRef::Name(name)` until the binder resolves to `SheetRef::Id`.
///
/// **W5-87 (Phase 4.6.A part 1):** `Copy` dropped because `SheetRef`
/// carries `Arc<str>` in the `Name` variant. Most existing callers
/// switch to `.clone()` (Arc clone is cheap) or pass by reference.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CellAddr {
    pub sheet: SheetRef,
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
/// **W5-87 (Phase 4.6.A part 1):** `Copy` dropped — `SheetRef` carries
/// `Arc<str>`. Same migration pattern as `CellAddr`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RangeRef {
    /// Bounded rectangular cell range. Start ≤ end on each axis (parser-normalized).
    /// `sheet: SheetRef::Current` = the formula's containing sheet.
    Cells {
        sheet: SheetRef,
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
        sheet: SheetRef,
        start_col: ColId,
        end_col: ColId,
        abs_start: bool,
        abs_end: bool,
    },
    /// Whole-row range (e.g. `1:1`, `2:5`). Cols span the full sheet.
    WholeRow {
        sheet: SheetRef,
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
            sheet: SheetRef::Current,
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
                    sheet: SheetRef::Current,
                    col: 0,
                    row: 0,
                    abs_col: false,
                    abs_row: false,
                }),
                Expr::CellRef(CellAddr {
                    sheet: SheetRef::Current,
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
            sheet: SheetRef::Current,
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
            sheet: SheetRef::Current,
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
            sheet: SheetRef::Current,
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
            sheet: SheetRef::Current,
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
            sheet: SheetRef::Current,
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        };
        let row = RangeRef::WholeRow {
            sheet: SheetRef::Current,
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

    // W5-91 (Phase 4.6.C) — rewrite_sheet_name_in_expr coverage.

    fn cell(sheet: SheetRef, col: u32, row: u32) -> Expr {
        Expr::CellRef(CellAddr {
            sheet,
            col,
            row,
            abs_col: false,
            abs_row: false,
        })
    }

    #[test]
    fn rewrite_renames_matching_cellref_sheet_name() {
        let expr = cell(SheetRef::Name(Arc::from("OldSheet")), 0, 0);
        let new_name: Arc<str> = Arc::from("NewSheet");
        let out = rewrite_sheet_name_in_expr(&expr, "OLDSHEET", &new_name);
        match out {
            Expr::CellRef(addr) => match addr.sheet {
                SheetRef::Name(n) => assert_eq!(&*n, "NewSheet"),
                other => panic!("expected SheetRef::Name, got {other:?}"),
            },
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_skips_current_and_id_sheet_refs() {
        // SheetRef::Current passes through untouched.
        let expr = cell(SheetRef::Current, 0, 0);
        let new_name: Arc<str> = Arc::from("New");
        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
        assert_eq!(out, expr);

        // SheetRef::Id passes through untouched (rename hits AST by name,
        // not by id — Id-bound refs survive across renames by design).
        let expr_id = cell(SheetRef::Id(7), 0, 0);
        let out_id = rewrite_sheet_name_in_expr(&expr_id, "OLD", &new_name);
        assert_eq!(out_id, expr_id);
    }

    #[test]
    fn rewrite_non_matching_name_passes_through() {
        let expr = cell(SheetRef::Name(Arc::from("Other")), 0, 0);
        let new_name: Arc<str> = Arc::from("New");
        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
        assert_eq!(out, expr);
    }

    #[test]
    fn rewrite_recurses_into_binary_and_function() {
        let lhs = cell(SheetRef::Name(Arc::from("Old")), 0, 0);
        let rhs_inner = cell(SheetRef::Name(Arc::from("Old")), 1, 0);
        let expr = Expr::Binary {
            op: crate::token::Operator::Plus,
            lhs: Box::new(lhs),
            rhs: Box::new(Expr::Function {
                name: Arc::from("SUM"),
                args: vec![rhs_inner],
            }),
        };
        let new_name: Arc<str> = Arc::from("Renamed");
        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
        match out {
            Expr::Binary { lhs, rhs, .. } => {
                match *lhs {
                    Expr::CellRef(addr) => match addr.sheet {
                        SheetRef::Name(n) => assert_eq!(&*n, "Renamed"),
                        other => panic!("expected SheetRef::Name, got {other:?}"),
                    },
                    other => panic!("expected CellRef in lhs, got {other:?}"),
                }
                match *rhs {
                    Expr::Function { args, .. } => match &args[0] {
                        Expr::CellRef(addr) => match &addr.sheet {
                            SheetRef::Name(n) => assert_eq!(&**n, "Renamed"),
                            other => panic!("expected SheetRef::Name, got {other:?}"),
                        },
                        other => panic!("expected CellRef arg, got {other:?}"),
                    },
                    other => panic!("expected Function in rhs, got {other:?}"),
                }
            }
            other => panic!("expected Binary, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_recurses_into_rangeref_cells() {
        let rng = Expr::RangeRef(RangeRef::Cells {
            sheet: SheetRef::Name(Arc::from("OldSheet")),
            start_col: 0,
            start_row: 0,
            end_col: 2,
            end_row: 4,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        });
        let new_name: Arc<str> = Arc::from("NewSheet");
        let out = rewrite_sheet_name_in_expr(&rng, "OLDSHEET", &new_name);
        match out {
            Expr::RangeRef(RangeRef::Cells { sheet, .. }) => match sheet {
                SheetRef::Name(n) => assert_eq!(&*n, "NewSheet"),
                other => panic!("expected SheetRef::Name, got {other:?}"),
            },
            other => panic!("expected RangeRef::Cells, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_is_case_insensitive_on_match() {
        // Stored ref is "oldsheet" lower; canonical comparison key is uppercase.
        let expr = cell(SheetRef::Name(Arc::from("oldsheet")), 0, 0);
        let new_name: Arc<str> = Arc::from("NewSheet");
        let out = rewrite_sheet_name_in_expr(&expr, "OLDSHEET", &new_name);
        match out {
            Expr::CellRef(addr) => match addr.sheet {
                SheetRef::Name(n) => assert_eq!(&*n, "NewSheet"),
                other => panic!("expected SheetRef::Name, got {other:?}"),
            },
            other => panic!("expected CellRef, got {other:?}"),
        }
    }
}
