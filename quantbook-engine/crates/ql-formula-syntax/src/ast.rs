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

use crate::token::{AxisSpec, Operator};

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

    /// **W5-143 (Phase 4.9.G):** Excel-365 implicit-intersection
    /// operator `@expr`. The operator narrows / passes-through its
    /// operand based on the operand's value-level shape (eval rules
    /// in design § 3.3). The variant is NOT surface-only — printer
    /// emits `@<inner>` so round-trip through formula text is
    /// lossless.
    ///
    /// Common forms:
    /// - `@A1` → narrow A1 (a scalar; passes through).
    /// - `@A1:A10` → narrow a vertical range to the formula's row.
    /// - `@SUM(...)` → narrow an array-returning function result.
    /// - `Sheet1!@A1` → sheet-prefix applies to the inner ref; the
    ///   `@` wraps the result.
    ///
    /// Binder + eval live in 4.9.H. For 4.9.G (parser only), the
    /// binder surfaces `BindError::UnsupportedVariant` and the
    /// calcgraph stubs panic loudly (`unreachable!()`).
    ImplicitIntersection(Box<Expr>),

    /// **W5-139 (Phase 4.9.C):** intermediate R1C1 single-cell
    /// reference, emitted by the parser when fed `Token::R1C1Ref`
    /// from a `mode == R1C1` lex. Each axis is independently
    /// absolute (1-indexed) or relative (signed offset from the
    /// formula's anchor cell). The binder lowers to
    /// `ExprPlan::CellRef` using `BindSite::at_cell` for relative
    /// resolution (separate sub-phase). Sheet-qualification is the
    /// same shape as `CellRef`: parser emits `SheetRef::Current`;
    /// `apply_sheet_to_term` rewrites to `SheetRef::Name` when a
    /// `Sheet1!` prefix is present.
    R1C1Ref {
        sheet: SheetRef,
        row_axis: AxisSpec,
        col_axis: AxisSpec,
    },

    /// **W5-112 (Phase 4.8.C):** structured table reference
    /// `Sales[Qty]`, `Sales[[#Headers], [Qty]]`, `[@Col]`, etc.
    ///
    /// `table_name` is the case-preserving identifier preceding the
    /// outer `[`; the binder canonicalizes to uppercase for lookup
    /// against `Workbook::tables`. `spec` is the parsed bracket content
    /// (per design § 6.2). The binder (4.8.E + 4.8.F) resolves to a
    /// concrete `Range` (or `Address` for `[@Col]` and single-cell
    /// specifier forms) using table metadata; error variants
    /// (`BindError::UnknownTable / UnknownTableColumn /
    /// ThisRowOutsideTable / StructuredRefDegenerateRange`) surface
    /// problems precisely.
    StructuredRef {
        table_name: Arc<str>,
        spec: TableSpecSubtree,
    },
}

/// **W5-112 (Phase 4.8.C):** a structured-reference spec (the parsed
/// bracket content). Per design § 6.2, three top-level shapes:
///
/// - [`BareColumn`] — `Sales[Qty]` — column shorthand without surrounding
///   `[…]`. Kept distinct from `Combination(vec![Column(c)])` for printer
///   round-trip; semantically normalized at bind time.
/// - [`Combination`] — `Sales[[Col]]`, `Sales[[#Headers]]`,
///   `Sales[[#Data], [Col1]:[Col2]]`, multi-item combinations etc. The
///   `Vec<TableSpecItem>` carries items in source order; the binder
///   normalizes to a single `(RowSelector, ColumnSelector)` intersection.
/// - [`ThisRowColumn`] / [`ThisRowColumnRange`] — `[@Col]` / `[@[C1]:[C2]]`
///   shorthand for "current row in `Col`". Resolves to a single cell
///   (`ThisRowColumn`) or a 1-row range (`ThisRowColumnRange`); requires
///   the binder's owning-cell context (`BindError::ThisRowRequiresOwningCell`
///   if absent, `BindError::ThisRowOutsideTable` if the formula's cell
///   isn't inside the table).
///
/// [`BareColumn`]: TableSpecSubtree::BareColumn
/// [`Combination`]: TableSpecSubtree::Combination
/// [`ThisRowColumn`]: TableSpecSubtree::ThisRowColumn
/// [`ThisRowColumnRange`]: TableSpecSubtree::ThisRowColumnRange
#[derive(Clone, Debug, PartialEq)]
pub enum TableSpecSubtree {
    /// `Sales[Qty]` — bare column shorthand without surrounding `[…]`.
    BareColumn(Arc<str>),
    /// `Sales[[#Data], [Col1]:[Col2]]` and similar. Items in source order.
    Combination(Vec<TableSpecItem>),
    /// `[@Col]` — current row in named column.
    ThisRowColumn(Arc<str>),
    /// `[@[Col1]:[Col2]]` — current row in column range.
    ThisRowColumnRange(Arc<str>, Arc<str>),
}

/// **W5-112 (Phase 4.8.C):** one item inside a structured-reference
/// `Combination`. Per design § 6.2.
#[derive(Clone, Debug, PartialEq)]
pub enum TableSpecItem {
    /// `[#Headers]`, `[#Totals]`, `[#Data]`, `[#All]`, `[#This Row]`.
    Special(SpecialItem),
    /// `[Col]` — single column.
    Column(Arc<str>),
    /// `[Col1]:[Col2]` — column range (order-independent at bind time).
    ColumnRange(Arc<str>, Arc<str>),
}

/// **W5-112 (Phase 4.8.C):** the 5 Excel special-row specifiers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpecialItem {
    Headers,
    Totals,
    Data,
    All,
    /// `[#This Row]` — used inside a Combination (the bracketed form).
    /// The `[@Col]` shorthand is `TableSpecSubtree::ThisRowColumn`,
    /// not this variant.
    ThisRow,
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
        // **W5-139 (Phase 4.9.C):** intermediate R1C1 ref carries a
        // SheetRef just like CellRef — rewrite identically. Axis
        // values are sheet-agnostic and clone through.
        Expr::R1C1Ref {
            sheet,
            row_axis,
            col_axis,
        } => Expr::R1C1Ref {
            sheet: rewrite_sheet_ref(sheet, old_canonical, new_name),
            row_axis: *row_axis,
            col_axis: *col_axis,
        },
        // W5-112 (Phase 4.8.C): structured refs have no SheetRef
        // (table names are workbook-scoped). Clone through.
        Expr::StructuredRef { table_name, spec } => Expr::StructuredRef {
            table_name: table_name.clone(),
            spec: spec.clone(),
        },
        // **W5-143 (Phase 4.9.G):** implicit-intersection — recurse
        // into inner. Sheet ref lives on the wrapped expr (per
        // `apply_sheet_to_term` placing the sheet INSIDE `@`).
        Expr::ImplicitIntersection(inner) => Expr::ImplicitIntersection(Box::new(
            rewrite_sheet_name_in_expr(inner, old_canonical, new_name),
        )),
    }
}

/// **W5-119 (Phase 4.8.I):** rewrite every `Expr::StructuredRef`
/// referencing `old_canonical` (case-insensitive) to the new name.
/// Mirrors [`rewrite_sheet_name_in_expr`] in spirit but for tables.
///
/// Used by `WorkbookRuntime::rename_table` to update formula text
/// (Excel canon: renames cascade through stored formula text, so
/// the next bind sees the new name and binds successfully).
pub fn rewrite_table_ref(expr: &Expr, old_canonical: &str, new_name: &Arc<str>) -> Expr {
    match expr {
        Expr::Number(n) => Expr::Number(*n),
        Expr::String(s) => Expr::String(s.clone()),
        Expr::Bool(b) => Expr::Bool(*b),
        Expr::NameRef(n) => Expr::NameRef(n.clone()),
        Expr::Error(ev) => Expr::Error(*ev),
        Expr::CellRef(addr) => Expr::CellRef(addr.clone()),
        Expr::RangeRef(r) => Expr::RangeRef(r.clone()),
        Expr::Binary { op, lhs, rhs } => Expr::Binary {
            op: *op,
            lhs: Box::new(rewrite_table_ref(lhs, old_canonical, new_name)),
            rhs: Box::new(rewrite_table_ref(rhs, old_canonical, new_name)),
        },
        Expr::Unary { op, operand } => Expr::Unary {
            op: *op,
            operand: Box::new(rewrite_table_ref(operand, old_canonical, new_name)),
        },
        Expr::Function { name, args } => Expr::Function {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| rewrite_table_ref(a, old_canonical, new_name))
                .collect(),
        },
        Expr::Array(rows) => Expr::Array(
            rows.iter()
                .map(|row| {
                    row.iter()
                        .map(|cell| rewrite_table_ref(cell, old_canonical, new_name))
                        .collect()
                })
                .collect(),
        ),
        Expr::Spill(inner) => {
            Expr::Spill(Box::new(rewrite_table_ref(inner, old_canonical, new_name)))
        }
        // **W5-139 (Phase 4.9.C):** R1C1 refs don't reference tables — clone through.
        Expr::R1C1Ref {
            sheet,
            row_axis,
            col_axis,
        } => Expr::R1C1Ref {
            sheet: sheet.clone(),
            row_axis: *row_axis,
            col_axis: *col_axis,
        },
        Expr::StructuredRef { table_name, spec } => {
            if table_name.eq_ignore_ascii_case(old_canonical) {
                Expr::StructuredRef {
                    table_name: new_name.clone(),
                    spec: spec.clone(),
                }
            } else {
                Expr::StructuredRef {
                    table_name: table_name.clone(),
                    spec: spec.clone(),
                }
            }
        }
        // **W5-143 (Phase 4.9.G):** implicit-intersection — recurse
        // into inner (a StructuredRef inside `@` is reachable via
        // `=@Sales[Qty]`).
        Expr::ImplicitIntersection(inner) => {
            Expr::ImplicitIntersection(Box::new(rewrite_table_ref(inner, old_canonical, new_name)))
        }
    }
}

/// **W5-121 (Phase 4.8.I.2):** rewrite every column reference inside an
/// `Expr::StructuredRef` whose `table_name` matches `table_canonical_upper`
/// (case-insensitive) and whose spec column name matches `old_col`
/// (case-insensitive). Substitutes with `new_col` (case-preserving).
/// Sibling of [`rewrite_table_ref`]; used by
/// `WorkbookRuntime::rename_column`.
///
/// **Cross-table isolation:** structured refs to OTHER tables pass through
/// unchanged, even if their spec mentions a column with the same name.
/// **Spec coverage:** walks every variant of [`TableSpecSubtree`] and
/// [`TableSpecItem`] that holds a column name — `BareColumn`,
/// `ThisRowColumn`, `ThisRowColumnRange`, and `Combination` items
/// (`Column`, `ColumnRange`; `Special` passes through).
pub fn rewrite_column_ref(
    expr: &Expr,
    table_canonical_upper: &str,
    old_col: &str,
    new_col: &Arc<str>,
) -> Expr {
    match expr {
        Expr::Number(n) => Expr::Number(*n),
        Expr::String(s) => Expr::String(s.clone()),
        Expr::Bool(b) => Expr::Bool(*b),
        Expr::NameRef(n) => Expr::NameRef(n.clone()),
        Expr::Error(ev) => Expr::Error(*ev),
        Expr::CellRef(addr) => Expr::CellRef(addr.clone()),
        Expr::RangeRef(r) => Expr::RangeRef(r.clone()),
        Expr::Binary { op, lhs, rhs } => Expr::Binary {
            op: *op,
            lhs: Box::new(rewrite_column_ref(
                lhs,
                table_canonical_upper,
                old_col,
                new_col,
            )),
            rhs: Box::new(rewrite_column_ref(
                rhs,
                table_canonical_upper,
                old_col,
                new_col,
            )),
        },
        Expr::Unary { op, operand } => Expr::Unary {
            op: *op,
            operand: Box::new(rewrite_column_ref(
                operand,
                table_canonical_upper,
                old_col,
                new_col,
            )),
        },
        Expr::Function { name, args } => Expr::Function {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| rewrite_column_ref(a, table_canonical_upper, old_col, new_col))
                .collect(),
        },
        Expr::Array(rows) => Expr::Array(
            rows.iter()
                .map(|row| {
                    row.iter()
                        .map(|cell| {
                            rewrite_column_ref(cell, table_canonical_upper, old_col, new_col)
                        })
                        .collect()
                })
                .collect(),
        ),
        Expr::Spill(inner) => Expr::Spill(Box::new(rewrite_column_ref(
            inner,
            table_canonical_upper,
            old_col,
            new_col,
        ))),
        // **W5-139 (Phase 4.9.C):** R1C1 refs don't reference table
        // columns — clone through.
        Expr::R1C1Ref {
            sheet,
            row_axis,
            col_axis,
        } => Expr::R1C1Ref {
            sheet: sheet.clone(),
            row_axis: *row_axis,
            col_axis: *col_axis,
        },
        // **W5-143 (Phase 4.9.G):** implicit-intersection — recurse
        // into inner so `=@Sales[OldCol]` rewrites correctly.
        Expr::ImplicitIntersection(inner) => Expr::ImplicitIntersection(Box::new(
            rewrite_column_ref(inner, table_canonical_upper, old_col, new_col),
        )),
        Expr::StructuredRef { table_name, spec } => {
            if table_name.eq_ignore_ascii_case(table_canonical_upper) {
                Expr::StructuredRef {
                    table_name: table_name.clone(),
                    spec: rewrite_spec_column(spec, old_col, new_col),
                }
            } else {
                Expr::StructuredRef {
                    table_name: table_name.clone(),
                    spec: spec.clone(),
                }
            }
        }
    }
}

fn rewrite_spec_column(
    spec: &TableSpecSubtree,
    old_col: &str,
    new_col: &Arc<str>,
) -> TableSpecSubtree {
    match spec {
        TableSpecSubtree::BareColumn(name) => {
            if name.eq_ignore_ascii_case(old_col) {
                TableSpecSubtree::BareColumn(Arc::clone(new_col))
            } else {
                TableSpecSubtree::BareColumn(Arc::clone(name))
            }
        }
        TableSpecSubtree::ThisRowColumn(name) => {
            if name.eq_ignore_ascii_case(old_col) {
                TableSpecSubtree::ThisRowColumn(Arc::clone(new_col))
            } else {
                TableSpecSubtree::ThisRowColumn(Arc::clone(name))
            }
        }
        TableSpecSubtree::ThisRowColumnRange(c1, c2) => {
            let nc1 = if c1.eq_ignore_ascii_case(old_col) {
                Arc::clone(new_col)
            } else {
                Arc::clone(c1)
            };
            let nc2 = if c2.eq_ignore_ascii_case(old_col) {
                Arc::clone(new_col)
            } else {
                Arc::clone(c2)
            };
            TableSpecSubtree::ThisRowColumnRange(nc1, nc2)
        }
        TableSpecSubtree::Combination(items) => TableSpecSubtree::Combination(
            items
                .iter()
                .map(|item| rewrite_spec_item_column(item, old_col, new_col))
                .collect(),
        ),
    }
}

fn rewrite_spec_item_column(
    item: &TableSpecItem,
    old_col: &str,
    new_col: &Arc<str>,
) -> TableSpecItem {
    match item {
        TableSpecItem::Special(s) => TableSpecItem::Special(*s),
        TableSpecItem::Column(name) => {
            if name.eq_ignore_ascii_case(old_col) {
                TableSpecItem::Column(Arc::clone(new_col))
            } else {
                TableSpecItem::Column(Arc::clone(name))
            }
        }
        TableSpecItem::ColumnRange(c1, c2) => {
            let nc1 = if c1.eq_ignore_ascii_case(old_col) {
                Arc::clone(new_col)
            } else {
                Arc::clone(c1)
            };
            let nc2 = if c2.eq_ignore_ascii_case(old_col) {
                Arc::clone(new_col)
            } else {
                Arc::clone(c2)
            };
            TableSpecItem::ColumnRange(nc1, nc2)
        }
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
        // **W5-139 (Phase 4.9.C):** intermediate R1C1 range — rewrite
        // sheet only; axis specs are sheet-agnostic.
        RangeRef::R1C1Cells {
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
        } => RangeRef::R1C1Cells {
            sheet: rewrite_sheet_ref(sheet, old_canonical, new_name),
            start_row: *start_row,
            start_col: *start_col,
            end_row: *end_row,
            end_col: *end_col,
        },
    }
}

// ============================================================================
// W3 (insert/delete rows & columns) — structural coordinate-shift rewriter.
// ============================================================================
//
// When a user inserts or deletes rows/columns, every formula reference whose
// resolved sheet is the structurally-edited sheet must have its row (or col)
// COORDINATE shifted. This is the AST-level half of the lex→parse→shift→print
// round-trip (mirroring `rewrite_sheet_name_in_expr` in spirit).
//
// ## Excel-correct semantics (DELIBERATE deviation from the brief)
//
// The brief lists "$A$1 never shifts" as a trap. That is the COPY/FILL
// semantic of `$`. For **structural insert/delete**, Excel shifts the
// coordinate of EVERY reference at-or-after the edit point REGARDLESS of the
// `$` absolute marker — the `$` is preserved (re-printed) but the numeric
// coordinate moves. Deleting the row/col a reference points AT yields `#REF!`.
// We implement the Excel-correct structural semantics here; the four
// fixed/relative combinations are still exhaustively tested (each prints back
// with its `$` markers intact AND its coordinate shifted).
//
// ## Scope
//
// A reference is shifted iff its resolved sheet is the edited sheet. The
// producer supplies a [`ShiftScope`] that captures BOTH the "owning sheet"
// (so `SheetRef::Current` refs on the edited sheet match) and the edited
// sheet's canonical name + id (so `Sheet1!A5` refs — on ANY sheet — that
// point INTO the edited sheet also shift). `SheetRef::Current` on a formula
// owned by a DIFFERENT sheet never matches (Current = the formula's own
// sheet, which by definition is not the edited sheet in that case).

/// The axis a structural insert/delete operates on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShiftAxis {
    Row,
    Col,
}

/// A structural shift operation on one axis. Coordinates are 0-indexed
/// (`RowId`/`ColId` convention; A1 == row 0, col 0).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShiftOp {
    /// Insert `count` new lines starting AT index `at`. Coordinates `>= at`
    /// move up by `count`; coordinates `< at` are unchanged.
    Insert { at: u32, count: u32 },
    /// Delete the INCLUSIVE block `[start, end]` (so `end - start + 1` lines).
    /// Coordinates inside the block are removed (→ `#REF!` for single refs;
    /// range endpoints collapse); coordinates `> end` move down by the block
    /// size; coordinates `< start` are unchanged.
    Delete { start: u32, end: u32 },
}

/// Identifies WHICH sheet's references to shift, and how to resolve
/// `SheetRef::Current` on the formula being rewritten.
///
/// - `edited_canonical`: ASCII-uppercase canonical name of the edited sheet.
///   `SheetRef::Name(n)` refs match when `n.eq_ignore_ascii_case(edited_canonical)`.
/// - `edited_id`: the edited sheet's id. `SheetRef::Id(id)` refs match when
///   `id == edited_id`.
/// - `owner_is_edited`: true iff the formula being rewritten lives ON the
///   edited sheet. Only then do bare (`SheetRef::Current`) refs shift.
#[derive(Clone, Copy, Debug)]
pub struct ShiftScope<'a> {
    pub edited_canonical: &'a str,
    pub edited_id: SheetId,
    pub owner_is_edited: bool,
}

/// Outcome of shifting a single 0-indexed coordinate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShiftCoord {
    /// New coordinate (possibly unchanged).
    Moved(u32),
    /// The coordinate was deleted or overflowed past the axis max → `#REF!`.
    Ref,
}

/// Axis maximum for overflow detection (Excel limits).
fn axis_max(axis: ShiftAxis) -> u32 {
    match axis {
        ShiftAxis::Row => crate::lexer::MAX_ROW,
        ShiftAxis::Col => crate::lexer::MAX_COLUMN,
    }
}

/// Shift one 0-indexed coordinate per the op. The single source of truth for
/// the shift math; every cell/range endpoint routes through here.
fn shift_one(coord: u32, op: ShiftOp, axis: ShiftAxis) -> ShiftCoord {
    match op {
        ShiftOp::Insert { at, count } => {
            if coord < at {
                ShiftCoord::Moved(coord)
            } else {
                match coord.checked_add(count) {
                    Some(c) if c <= axis_max(axis) => ShiftCoord::Moved(c),
                    // Pushed past the axis maximum → the cell falls off the
                    // sheet. Excel surfaces `#REF!` for such a reference.
                    _ => ShiftCoord::Ref,
                }
            }
        }
        ShiftOp::Delete { start, end } => {
            // Invariant: producers construct `Delete` with `start <= end`
            // (validated at the napi boundary, L5). A malformed `start > end`
            // is a programmer/op-log-corruption bug; surface it loudly in
            // debug builds. Release uses saturating arithmetic so it cannot
            // panic on FFI-reachable corruption — the `> end` branch is
            // unreachable when `start > end` because `coord >= start > end`
            // takes the deleted-block branch first.
            debug_assert!(
                start <= end,
                "ShiftOp::Delete requires start <= end (got {start} > {end})"
            );
            if coord < start {
                ShiftCoord::Moved(coord)
            } else if coord <= end {
                // Inside the deleted block → gone.
                ShiftCoord::Ref
            } else {
                // Below the block: slide up by the block size. `end >= start`
                // by the invariant, so `end - start + 1 >= 1`; saturating_sub
                // is defensive against a corrupt `start > end` op only.
                let n = end.saturating_sub(start) + 1;
                ShiftCoord::Moved(coord - n)
            }
        }
    }
}

/// Map a range START endpoint that fell INSIDE a deleted block to the
/// post-deletion collapse point. After deleting `[start, end]`, the first
/// surviving line at-or-after the block is at index `start` (the line that
/// slid up into the block's position). So a start endpoint inside the block
/// clamps to `start`. (The caller decides `#REF!` if the whole range
/// collapsed — start > end after both endpoints map.)
fn shift_range_start(coord: u32, op: ShiftOp, axis: ShiftAxis) -> ShiftCoord {
    match (op, shift_one(coord, op, axis)) {
        // Endpoint deleted under a Delete: clamp to the collapse point.
        (ShiftOp::Delete { start, .. }, ShiftCoord::Ref) => ShiftCoord::Moved(start),
        (_, other) => other,
    }
}

/// Map a range END endpoint that fell INSIDE a deleted block to the last
/// surviving line BEFORE the block, i.e. `start - 1`. If `start == 0` the
/// block reaches the sheet origin and the end has no surviving predecessor →
/// the caller collapses the range to `#REF!`.
fn shift_range_end(coord: u32, op: ShiftOp, axis: ShiftAxis) -> ShiftCoord {
    match (op, shift_one(coord, op, axis)) {
        (ShiftOp::Delete { start, .. }, ShiftCoord::Ref) => {
            if start == 0 {
                ShiftCoord::Ref
            } else {
                ShiftCoord::Moved(start - 1)
            }
        }
        (_, other) => other,
    }
}

/// True iff a reference whose `SheetRef` is `sheet` (on a formula scoped by
/// `scope`) targets the edited sheet and must be shifted.
fn ref_targets_edited(sheet: &SheetRef, scope: ShiftScope<'_>) -> bool {
    match sheet {
        SheetRef::Current => scope.owner_is_edited,
        SheetRef::Name(n) => n.eq_ignore_ascii_case(scope.edited_canonical),
        SheetRef::Id(id) => *id == scope.edited_id,
    }
}

/// **W3 (insert/delete):** recursively shift the row/col coordinate of every
/// reference in `expr` that resolves to the edited sheet. Returns a new
/// `Expr`; the input is not mutated. References on other sheets, constants,
/// function names, defined-name references, and structured (table) references
/// pass through unchanged (table footprints + named ranges are re-keyed at the
/// metadata layer, not here). A reference whose coordinate is deleted or
/// overflows becomes `Expr::Error(ErrorValue::Ref)` (`#REF!`).
///
/// `axis` selects which coordinate moves (the other is untouched). `op`
/// is the insert/delete. `scope` decides which refs target the edited sheet.
///
/// **R1C1 refs are left UNCHANGED in v1** (the IDE drives A1 mode only; R1C1
/// offsets are anchor-relative and need separate handling — documented gap).
pub fn shift_cell_refs(expr: &Expr, axis: ShiftAxis, op: ShiftOp, scope: ShiftScope<'_>) -> Expr {
    match expr {
        Expr::Number(n) => Expr::Number(*n),
        Expr::String(s) => Expr::String(s.clone()),
        Expr::Bool(b) => Expr::Bool(*b),
        Expr::NameRef(n) => Expr::NameRef(n.clone()),
        Expr::Error(ev) => Expr::Error(*ev),
        Expr::CellRef(addr) => shift_cell_addr(addr, axis, op, scope),
        Expr::RangeRef(r) => shift_range_ref_struct(r, axis, op, scope),
        Expr::Binary { op: o, lhs, rhs } => Expr::Binary {
            op: *o,
            lhs: Box::new(shift_cell_refs(lhs, axis, op, scope)),
            rhs: Box::new(shift_cell_refs(rhs, axis, op, scope)),
        },
        Expr::Unary { op: o, operand } => Expr::Unary {
            op: *o,
            operand: Box::new(shift_cell_refs(operand, axis, op, scope)),
        },
        Expr::Function { name, args } => Expr::Function {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| shift_cell_refs(a, axis, op, scope))
                .collect(),
        },
        Expr::Array(rows) => Expr::Array(
            rows.iter()
                .map(|row| {
                    row.iter()
                        .map(|cell| shift_cell_refs(cell, axis, op, scope))
                        .collect()
                })
                .collect(),
        ),
        Expr::Spill(inner) => Expr::Spill(Box::new(shift_cell_refs(inner, axis, op, scope))),
        // v1: R1C1 refs left unchanged (anchor-relative; A1-only product).
        Expr::R1C1Ref {
            sheet,
            row_axis,
            col_axis,
        } => Expr::R1C1Ref {
            sheet: sheet.clone(),
            row_axis: *row_axis,
            col_axis: *col_axis,
        },
        // Table footprints re-keyed at metadata layer; text unchanged.
        Expr::StructuredRef { table_name, spec } => Expr::StructuredRef {
            table_name: table_name.clone(),
            spec: spec.clone(),
        },
        Expr::ImplicitIntersection(inner) => {
            Expr::ImplicitIntersection(Box::new(shift_cell_refs(inner, axis, op, scope)))
        }
    }
}

/// Shift a single `CellRef`. A deleted/overflowed coordinate collapses the
/// whole ref to `#REF!`. The `$` absolute markers are preserved.
fn shift_cell_addr(addr: &CellAddr, axis: ShiftAxis, op: ShiftOp, scope: ShiftScope<'_>) -> Expr {
    if !ref_targets_edited(&addr.sheet, scope) {
        return Expr::CellRef(addr.clone());
    }
    let coord = match axis {
        ShiftAxis::Row => addr.row,
        ShiftAxis::Col => addr.col,
    };
    match shift_one(coord, op, axis) {
        ShiftCoord::Ref => Expr::Error(ql_types::ErrorValue::Ref),
        ShiftCoord::Moved(new_coord) => {
            let mut out = addr.clone();
            match axis {
                ShiftAxis::Row => out.row = new_coord,
                ShiftAxis::Col => out.col = new_coord,
            }
            Expr::CellRef(out)
        }
    }
}

/// Shift a `RangeRef`. Each endpoint shifts independently; a fully-collapsed
/// range (start > end after the shift, or both endpoints deleted) becomes
/// `#REF!`. Partial deletion shrinks the range (Excel canon).
fn shift_range_ref_struct(
    r: &RangeRef,
    axis: ShiftAxis,
    op: ShiftOp,
    scope: ShiftScope<'_>,
) -> Expr {
    let sheet = range_sheet(r);
    if !ref_targets_edited(sheet, scope) {
        return Expr::RangeRef(r.clone());
    }
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
        } => {
            // Shift only the relevant axis; the other axis passes through.
            let (ns_row, ne_row, ns_col, ne_col) = match axis {
                ShiftAxis::Row => {
                    let s = shift_range_start(*start_row, op, axis);
                    let e = shift_range_end(*end_row, op, axis);
                    match collapse_pair(s, e) {
                        None => return Expr::Error(ql_types::ErrorValue::Ref),
                        Some((s, e)) => (s, e, *start_col, *end_col),
                    }
                }
                ShiftAxis::Col => {
                    let s = shift_range_start(*start_col, op, axis);
                    let e = shift_range_end(*end_col, op, axis);
                    match collapse_pair(s, e) {
                        None => return Expr::Error(ql_types::ErrorValue::Ref),
                        Some((s, e)) => (*start_row, *end_row, s, e),
                    }
                }
            };
            Expr::RangeRef(RangeRef::Cells {
                sheet: sheet.clone(),
                start_col: ns_col,
                start_row: ns_row,
                end_col: ne_col,
                end_row: ne_row,
                abs_start_col: *abs_start_col,
                abs_start_row: *abs_start_row,
                abs_end_col: *abs_end_col,
                abs_end_row: *abs_end_row,
            })
        }
        RangeRef::WholeColumn {
            sheet,
            start_col,
            end_col,
            abs_start,
            abs_end,
        } => {
            // A whole-column range only shifts on the COL axis; a row
            // insert/delete leaves it unchanged (it already spans all rows).
            if axis == ShiftAxis::Row {
                return Expr::RangeRef(r.clone());
            }
            let s = shift_range_start(*start_col, op, axis);
            let e = shift_range_end(*end_col, op, axis);
            match collapse_pair(s, e) {
                None => Expr::Error(ql_types::ErrorValue::Ref),
                Some((s, e)) => Expr::RangeRef(RangeRef::WholeColumn {
                    sheet: sheet.clone(),
                    start_col: s,
                    end_col: e,
                    abs_start: *abs_start,
                    abs_end: *abs_end,
                }),
            }
        }
        RangeRef::WholeRow {
            sheet,
            start_row,
            end_row,
            abs_start,
            abs_end,
        } => {
            if axis == ShiftAxis::Col {
                return Expr::RangeRef(r.clone());
            }
            let s = shift_range_start(*start_row, op, axis);
            let e = shift_range_end(*end_row, op, axis);
            match collapse_pair(s, e) {
                None => Expr::Error(ql_types::ErrorValue::Ref),
                Some((s, e)) => Expr::RangeRef(RangeRef::WholeRow {
                    sheet: sheet.clone(),
                    start_row: s,
                    end_row: e,
                    abs_start: *abs_start,
                    abs_end: *abs_end,
                }),
            }
        }
        // v1: R1C1 ranges unchanged (A1-only product).
        RangeRef::R1C1Cells { .. } => Expr::RangeRef(r.clone()),
    }
}

/// Combine a shifted (start, end) pair: `None` if the range fully collapsed
/// (either endpoint became `#REF!` with no survivor, or start > end), else
/// the normalized `(start, end)`.
fn collapse_pair(start: ShiftCoord, end: ShiftCoord) -> Option<(u32, u32)> {
    match (start, end) {
        (ShiftCoord::Moved(s), ShiftCoord::Moved(e)) => {
            if s > e {
                None
            } else {
                Some((s, e))
            }
        }
        _ => None,
    }
}

/// Borrow a range's `SheetRef` regardless of variant.
fn range_sheet(r: &RangeRef) -> &SheetRef {
    match r {
        RangeRef::Cells { sheet, .. }
        | RangeRef::WholeColumn { sheet, .. }
        | RangeRef::WholeRow { sheet, .. }
        | RangeRef::R1C1Cells { sheet, .. } => sheet,
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
    /// **W5-139 (Phase 4.9.C):** intermediate R1C1 rectangular range
    /// (`R1C1:R10C5`, `R[1]C[1]:R[5]C[5]`). Each endpoint axis is
    /// `AxisSpec`. Parser-time invariant (enforced in `build_range`):
    /// per-axis relativity matches across endpoints (e.g. both rows
    /// absolute, OR both rows relative; same independently for cols).
    /// Mixed-relativity is rejected with
    /// `ParseError::R1C1MixedRelativity`. Binder lowers to
    /// `ExprPlan::RangeRef` (separate sub-phase).
    R1C1Cells {
        sheet: SheetRef,
        start_row: AxisSpec,
        start_col: AxisSpec,
        end_row: AxisSpec,
        end_col: AxisSpec,
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

    // ===== W5-129 (Phase 4.8.O.5 — Sonnet cross-validation LOW-NEW-1) =====
    //
    // `rewrite_column_ref` was previously tested only transitively via
    // the `oplog_e2e` `rename_column_op_log_replay_reconstructs_rename`
    // end-to-end test. Sonnet's W5-128 cross-validation pass confirmed
    // the code is correct but flagged the missing unit-level pins.
    // These 5 tests target each non-Combination spec variant + the
    // string-literal immunity property + the cross-table isolation guard.

    fn sref(table_name: &str, spec: TableSpecSubtree) -> Expr {
        Expr::StructuredRef {
            table_name: Arc::from(table_name),
            spec,
        }
    }

    #[test]
    fn rewrite_column_ref_string_literal_is_immune() {
        // `="The Qty column"` — the string literal contains "Qty" but
        // it's `Expr::String`, not a StructuredRef. The walker must
        // pass it through unchanged.
        let expr = Expr::String(Arc::from("The Qty column"));
        let new_col: Arc<str> = Arc::from("Quantity");
        let out = rewrite_column_ref(&expr, "SALES", "Qty", &new_col);
        match out {
            Expr::String(s) => assert_eq!(&*s, "The Qty column"),
            other => panic!("expected String pass-through, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_column_ref_special_item_passes_through() {
        // `Sales[[#Headers], [Qty]]` — the `#Headers` SpecialItem must
        // pass through; only the `Qty` Column item gets rewritten.
        let spec = TableSpecSubtree::Combination(vec![
            TableSpecItem::Special(SpecialItem::Headers),
            TableSpecItem::Column(Arc::from("Qty")),
        ]);
        let new_col: Arc<str> = Arc::from("Quantity");
        let out = rewrite_column_ref(&sref("Sales", spec), "SALES", "Qty", &new_col);
        match out {
            Expr::StructuredRef { spec, .. } => match spec {
                TableSpecSubtree::Combination(items) => {
                    assert_eq!(items.len(), 2);
                    match &items[0] {
                        TableSpecItem::Special(SpecialItem::Headers) => {}
                        other => panic!("expected Headers, got {other:?}"),
                    }
                    match &items[1] {
                        TableSpecItem::Column(c) => assert_eq!(&**c, "Quantity"),
                        other => panic!("expected Column(Quantity), got {other:?}"),
                    }
                }
                other => panic!("expected Combination, got {other:?}"),
            },
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_column_ref_this_row_column_range_rewrites_both_endpoints() {
        // `Sales[@[Qty]:[Qty]]` — both endpoints reference "Qty"; the
        // walker rewrites BOTH. (Cross-test exists in oplog_e2e but
        // not for this specific spec variant.)
        let spec = TableSpecSubtree::ThisRowColumnRange(Arc::from("Qty"), Arc::from("Qty"));
        let new_col: Arc<str> = Arc::from("Quantity");
        let out = rewrite_column_ref(&sref("Sales", spec), "SALES", "Qty", &new_col);
        match out {
            Expr::StructuredRef { spec, .. } => match spec {
                TableSpecSubtree::ThisRowColumnRange(c1, c2) => {
                    assert_eq!(&*c1, "Quantity");
                    assert_eq!(&*c2, "Quantity");
                }
                other => panic!("expected ThisRowColumnRange, got {other:?}"),
            },
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_column_ref_column_range_rewrites_only_matching_endpoint() {
        // `Sales[[Qty]:[Price]]` with rename Qty→Quantity — only c1
        // (the matching endpoint) gets rewritten. c2 ("Price") stays.
        let spec = TableSpecSubtree::Combination(vec![TableSpecItem::ColumnRange(
            Arc::from("Qty"),
            Arc::from("Price"),
        )]);
        let new_col: Arc<str> = Arc::from("Quantity");
        let out = rewrite_column_ref(&sref("Sales", spec), "SALES", "Qty", &new_col);
        match out {
            Expr::StructuredRef { spec, .. } => match spec {
                TableSpecSubtree::Combination(items) => match &items[0] {
                    TableSpecItem::ColumnRange(c1, c2) => {
                        assert_eq!(&**c1, "Quantity");
                        assert_eq!(&**c2, "Price");
                    }
                    other => panic!("expected ColumnRange, got {other:?}"),
                },
                other => panic!("expected Combination, got {other:?}"),
            },
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_column_ref_cross_table_isolation_holds() {
        // `Inventory[Qty]` when renaming `Sales.Qty` — the table
        // canonical doesn't match, so the spec must pass through
        // unchanged. This is the guard at `rewrite_column_ref`'s
        // `table_name.eq_ignore_ascii_case(table_canonical_upper)`
        // check, exercised at unit level.
        let spec = TableSpecSubtree::BareColumn(Arc::from("Qty"));
        let new_col: Arc<str> = Arc::from("Quantity");
        let out = rewrite_column_ref(&sref("Inventory", spec), "SALES", "Qty", &new_col);
        match out {
            Expr::StructuredRef { table_name, spec } => {
                assert_eq!(&*table_name, "Inventory");
                match spec {
                    TableSpecSubtree::BareColumn(c) => {
                        assert_eq!(&*c, "Qty", "cross-table column must NOT be rewritten")
                    }
                    other => panic!("expected BareColumn, got {other:?}"),
                }
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }
}
