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
//! Covered through Phase 4.7:
//! - `RangeRef` — single range used inside a Function call (e.g. `SUM(A:A)`)
//!   — bound via the aggregate-context path (Phase 2B.4 / W5-39 evaluator).
//! - `Function { name, args }` — registry dispatch (Phase 0+).
//! - `Array(Vec<Vec<ExprPlan>>)` — array literals (W5-99 / Phase 4.7.F).
//! - `Error(ErrorValue)` — error-sigil literals (W5-99 / Phase 4.7.F).
//!
//! Deferred (NOT bound today):
//! - `Spill(Box<Expr>)` — reserved for Excel's `A1#` spill-range-ref
//!   syntax. Originally anticipated for Phase 4.9 but that phase
//!   closed (W5-138 → W5-152) without adding `A1#` parsing; deferred
//!   to a future Phase.

use std::sync::Arc;

use ql_formula_syntax::{AxisSpec, Expr, Operator, SheetRef};
use ql_types::{ColId, ErrorValue, Range, RowId, SheetId, MAX_COLUMN, MAX_ROW};

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

    /// **W5-99 (Phase 4.7.F):** array literal lowered from `Expr::Array`.
    /// Row-major; outer `Vec` is rows, inner `Vec` is cells. Element-arity
    /// is invariant — every row has the same length. The binder enforces
    /// this (`BindError::ArrayRowArityMismatch`) on every public input AND
    /// the parser already enforces it (`ParseError::ArrayRowArityMismatch`);
    /// defense in depth — the binder can't trust the AST because
    /// `Expr::Array` is a public variant that tests / tools can construct
    /// directly with ragged shapes.
    ///
    /// Inner `ExprPlan`s are restricted to the array-cell subset per
    /// design § 3.3: `Number` / `Bool` / `String` / `Error`. Cell-refs,
    /// function calls, and nested arrays are NOT permitted in v1 (already
    /// rejected at parse time via `ParseError::InvalidArrayCellToken`).
    /// The binder validates the same subset as defense in depth.
    ///
    /// Eval-site dispatch: Phase 4.7.G (W5-101). The runtime materializes
    /// an `ArrayValue` from this plan and routes to either the cell-
    /// boundary spill path (cell context) or `#CALC!` (scalar context),
    /// per design § 6.3.
    Array(Vec<Vec<ExprPlan>>),

    /// **W5-99 (Phase 4.7.F):** error-sigil literal lowered from
    /// `Expr::Error(ev)`. The evaluator returns `Value::Error(ev)` directly;
    /// the lowering is mechanical (no resolution, no context). Used by
    /// `=#REF!` formulas, `IFERROR(..., #N/A)` fallback args, and error
    /// literals inside `Expr::Array` cells.
    Error(ErrorValue),

    /// **W5-RT-1 (RT-V1-01):** literal range reference (`A1:B3`) lowered
    /// from `Expr::RangeRef` in `BindContext::ReferenceArg`. Carries the
    /// resolved [`Range`] directly, without requiring a name. Used as an
    /// argument to reference-aware functions (ROWS, COLUMNS, ROW with a
    /// range arg, etc.). Distinct from `AggregateNameRef` (which needs a
    /// name) and `StructuredRef` (which needs a table); the only path
    /// that reaches this variant today is `Expr::RangeRef` bound in
    /// `ReferenceArg` context. See design § 5.4.
    RangeRef {
        range: Range,
    },

    /// **W5-115 (Phase 4.8.F):** structured table reference resolved
    /// against the workbook's `TableTable`. The binder narrows the
    /// `TableSpecSubtree` source AST to a concrete [`Range`]; eval
    /// (Phase 4.8.G) reads the range like an `AggregateNameRef`.
    ///
    /// `is_this_row == true` indicates the source spec was a `[@Col]`
    /// shorthand (or `[[#This Row], [Col]]`): the resolved range
    /// covers the FULL column's data rows, and the eval layer NARROWS
    /// to a single cell using the formula's own row. This keeps the
    /// plan cache cell-INDEPENDENT for these forms (the resolved
    /// range only depends on the table metadata, not the formula
    /// cell).
    ///
    /// `source` is kept for printer round-trip (the printer renders the
    /// canonical `Table[…]` form, not the resolved range), error
    /// messages, and future invalidation hooks.
    StructuredRef {
        /// Canonical (uppercase) table name. Used by the dep extractor
        /// to register the formula in `table_to_formulas` for
        /// `on_table_*` dirty propagation (Phase 4.8.G).
        table_name: Arc<str>,
        /// Original parsed spec subtree (for printer / diagnostics).
        source: Arc<ql_formula_syntax::TableSpecSubtree>,
        /// Resolved range. For column refs: the column's data range.
        /// For `#Headers`: the header row's columns. For `#All`: the
        /// full footprint. For `[@Col]`: the column's FULL data range
        /// (eval narrows to current row).
        resolved: Range,
        /// `true` iff this is a `[@Col]` / `[[#This Row], [Col]]` form
        /// that requires cell-time row narrowing.
        is_this_row: bool,
    },
}

/// Error during binding. Phase 2A.1 added `UnresolvedName`; Phase 2A.6 added
/// `NamedTargetIs{Blank,Error}`; Phase 2A.11 audit M16 switched to
/// `thiserror::Error` for consistency with the rest of the error surface.
/// Display strings are now user-facing (suitable for IDE diagnostics).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum BindError {
    /// The Expr contains a variant not supported in this build. Currently
    /// reachable from:
    /// - `Expr::RangeRef` outside a Function context (Phase 4+ region binder).
    /// - `Expr::Spill` — Excel's `A1#` syntax (Phase 4.9).
    /// - `NamedTarget::Range` in scalar position (lands on the more
    ///   specific `NamedRangeInScalarContext` variant; this is the
    ///   catchall for variants the binder doesn't otherwise cover).
    ///
    /// Phase 4.7.F: `Expr::Array` and `Expr::Error` are now SUPPORTED;
    /// degenerate-array shapes surface as `EmptyArrayLiteral`, ragged
    /// shapes as `ArrayRowArityMismatch`, non-literal cells as
    /// `ArrayCellNotLiteral`.
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

    /// **W5-90 (Phase 4.6.B):** `SheetRef::Name(N)` from cross-sheet
    /// syntax (`Sheet1!A1`) didn't resolve to any sheet in the
    /// workbook at bind time. Surfaces as a clean bind-time diagnostic
    /// before any runtime read; closes XS-4-01.
    #[error("unknown sheet {0:?}")]
    UnknownSheet(Arc<str>),

    /// **W5-99 (Phase 4.7.F):** `Expr::Array` row N has a different
    /// length than row 0. The parser already enforces uniform arity
    /// (`ParseError::ArrayRowArityMismatch`), but `Expr::Array` is a
    /// PUBLIC variant — tests and tools can construct ragged arrays
    /// directly. Defense-in-depth: the binder rejects ragged shapes
    /// with this error rather than panicking (Codex MEDIUM-5 in the
    /// W5-94 design review).
    #[error("array literal row {row} has {found} cell(s), expected {expected} (matching row 0)")]
    ArrayRowArityMismatch { expected: u32, found: u32, row: u32 },

    /// **W5-99 (Phase 4.7.F):** `Expr::Array` contains a cell that
    /// isn't in the bind-allowed subset (Number / Bool / String /
    /// Error). The parser already restricts cell tokens at parse
    /// time, but defense-in-depth applies to tests / tools that
    /// construct `Expr::Array` directly. Lists what was found.
    #[error("array literal contains a non-literal cell at row {row}, col {col}: {got}")]
    ArrayCellNotLiteral {
        row: u32,
        col: u32,
        got: &'static str,
    },

    /// **W5-99 closure (Sonnet L-1 / Codex MEDIUM-7):** `Expr::Array`
    /// is degenerate — zero rows OR row 0 has zero cells. The parser
    /// rejects `{}` with `ParseError::EmptyArrayLiteral`, but
    /// `Expr::Array(vec![])` and `Expr::Array(vec![vec![]])` are
    /// directly-constructible from Rust code, so the binder is the
    /// second line of defense.
    #[error("array literal is degenerate (zero rows or zero cells per row)")]
    EmptyArrayLiteral,

    /// **W5-115 (Phase 4.8.F):** structured reference names a table
    /// that isn't registered in the workbook's `TableTable`. Mapped to
    /// `Value::Error(#NAME?)` at the cell value by `recompute_dirty`
    /// and `recompute_all` (W5-156, workbook_runtime.rs:2882 + :3266).
    /// `set_formula` still hard-rejects this variant; soft-acceptance
    /// of pre-existing-table refs awaits 4.8.N.
    #[error("unknown table {0:?}")]
    UnknownTable(std::sync::Arc<str>),

    /// **W5-115 (Phase 4.8.F):** structured reference names a column
    /// that doesn't exist in the named table's column roster. Mapped
    /// to `Value::Error(#NAME?)` at the cell value by `recompute_dirty`
    /// and `recompute_all` (W5-156) alongside `UnknownTable` — covers
    /// the resize-removes-referenced-column case (W5-159).
    #[error("unknown column {column:?} in table {table:?}")]
    UnknownTableColumn {
        table: std::sync::Arc<str>,
        column: std::sync::Arc<str>,
    },

    /// **W5-115 (Phase 4.8.F):** `[#Headers]` specifier on a table with
    /// `has_header == false`.
    #[error("table {0:?} has no header row; `[#Headers]` is not applicable")]
    TableHasNoHeader(std::sync::Arc<str>),

    /// **W5-115 (Phase 4.8.F):** `[#Totals]` specifier on a table with
    /// `has_totals == false`.
    #[error("table {0:?} has no totals row; `[#Totals]` is not applicable")]
    TableHasNoTotals(std::sync::Arc<str>),

    /// **W5-115 (Phase 4.8.F):** the spec resolves to a degenerate
    /// range (e.g. `[#Data]` on a header-only table with zero data rows).
    /// `ql_types::Range` is inclusive and can't represent zero rows;
    /// the binder surfaces this rather than constructing a malformed range.
    #[error("structured reference on table {0:?} resolves to a degenerate (zero-row) range")]
    StructuredRefDegenerateRange(std::sync::Arc<str>),

    /// **W5-115 (Phase 4.8.F):** `[@Col]` (`ThisRowColumn` /
    /// `ThisRowColumnRange`) form used without a known owning cell.
    /// Bind paths that don't have cell context (parse-only, syntax
    /// validation in tests) surface this; production paths always
    /// supply a cell via `BindSite::at_cell`.
    #[error("`[@Col]` shorthand requires an owning cell (none supplied)")]
    ThisRowRequiresOwningCell,

    /// **W5-140 (Phase 4.9.C binder):** an `Expr::R1C1Ref` with at
    /// least one relative axis (`AxisSpec::Rel(_)`) was bound under
    /// a `BindSite` lacking `cell` context. Relative R1C1 axes
    /// resolve against the formula's anchor cell at bind time per
    /// design § 3.1; without an anchor, resolution is impossible
    /// and we fail loud rather than silently substitute a default.
    /// Production storage canon (design § 4.4) ALWAYS supplies a
    /// `FormulaSite { cell }`; only parse-only / syntax-validation
    /// bind paths can surface this.
    #[error("R1C1 reference has a relative axis but no anchor cell was supplied")]
    R1C1RequiresAnchor,

    /// **W5-144 (Phase 4.9.H):** an `Expr::ImplicitIntersection`
    /// wrapping a range was bound under a `BindSite` lacking
    /// `cell` context. Range narrowing per design § 3.3 (rules 2/3/6)
    /// uses the formula's anchor cell to pick the row/col within
    /// the range span; without an anchor, resolution is impossible
    /// and we fail loud rather than silently substitute a default.
    /// Production storage canon (design § 4.4) ALWAYS supplies a
    /// `FormulaSite`; only parse-only / syntax-validation bind
    /// paths can surface this.
    #[error("`@<range>` narrowing requires a formula-cell anchor (none supplied)")]
    ImplicitIntersectionRequiresAnchor,

    /// **W5-140 (Phase 4.9.C binder):** R1C1 axis resolution
    /// produced a row or column outside the Excel grid
    /// (`MAX_ROW + 1` rows; `MAX_COLUMN + 1` cols, 1-indexed in
    /// source). Either an absolute axis exceeded the grid bound,
    /// or a relative offset added to the anchor coord overflowed /
    /// underflowed. Carries the structured-numeric resolution that
    /// failed so the IDE can render a precise diagnostic.
    #[error(
        "R1C1 reference resolves out of grid bounds: row={resolved_row:?}, col={resolved_col:?}"
    )]
    R1C1OutOfBounds {
        resolved_row: Option<i64>,
        resolved_col: Option<i64>,
    },
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
    /// formulas still error (Engine Phase 4 work). Step 1.1 closure
    /// (S1-LOW-2): the design v2 proposed renaming the matcher to
    /// `accepts_special_arg_at_bind`; that rename did not ship (see
    /// S1-HIGH-D — parallel-matcher approach kept instead). Doc-comment
    /// reverted to reference the actual matcher.
    AggregateArg,
    /// **W5-RT-1 (RT-V1-01):** inside the argument list of a reference-aware
    /// function (ROW, COLUMN, ROWS, COLUMNS, ISREF, ISFORMULA, FORMULATEXT).
    /// Same shape as `AggregateArg` for NameRef-resolves-to-range AND
    /// (NEW) accepts literal `Expr::RangeRef` lowering to
    /// `ExprPlan::RangeRef { range }`. CellRef args bind as
    /// `ExprPlan::CellRef` unchanged. The scope of the `RangeRef`
    /// lowering is intentionally narrow in v1: only this context accepts
    /// literal ranges. `AggregateArg`-side enabling (which would make
    /// `SUM(A1:B3)` work — currently a `BindError::UnsupportedVariant`)
    /// is a separate follow-up since the multi-tier dispatcher (scalar /
    /// range-aware / unified) would also need new `RangeRef` arms.
    ReferenceArg,
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
            // **W5-107 (Phase 4.7.N) — Codex audit HIGH closure**:
            // array-returning Unified-ABI functions that accept Range
            // / named-range args. TRANSPOSE accepts a Range (its only
            // arg). FILTER accepts a Range as both `array` and
            // `include` args. Without adding them here, the binder
            // rejects `FILTER(Data, Mask)` with
            // `NamedRangeInScalarContext` despite the function having
            // full FunctionArg::Range support in its body. SEQUENCE
            // is NOT added — it takes only scalar args (rows, cols,
            // start, step).
            | "TRANSPOSE"
            | "FILTER"
            // **W5-D-12 (Phase 4.10 V1-260 sealer) — Codex HIGH-001
            // closure**: SUBTOTAL is a range-aware conditional
            // aggregate. Without admission here, the binder rejects
            // `=SUBTOTAL(9, SalesRange)` with NamedRangeInScalarContext
            // (the function lookup succeeds, but its range arg can't
            // bind as `AggregateNameRef`). Eval-side dispatch routes
            // via the parallel `lookup_range_aware` table.
            | "SUBTOTAL"
            // **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex
            // HIGH-001 / Opus HIGH-1)**: SUBTOTAL was the ONLY fn
            // admitted by the W5-D-12 closure; the same systemic gap
            // affected 28 other range-aware fns that take range args.
            // The per-batch audits missed this because the unit tests
            // construct FnArg::Range directly (bypassing the binder)
            // and registry-lookup smoke tests prove the symbol is
            // registered but NOT that the binder routes range args to
            // it. Admitting all of them here closes the gap.
            //
            // Phase 4.10 statistical paired-array fns (W5-177, W5-178,
            // W5-179, W5-D-6) — take 2 ranges:
            | "CORREL"
            | "PEARSON"
            | "RSQ"
            | "STEYX"
            | "SLOPE"
            | "INTERCEPT"
            | "COVARIANCE.P"
            | "COVARIANCE.S"
            | "SUMX2MY2"
            | "SUMX2PY2"
            | "SUMXMY2"
            // Phase 4.10 financial cash-flow fns (W5-168, W5-174,
            // W5-D-7) — take 1-2 ranges:
            | "NPV"
            | "IRR"
            | "MIRR"
            | "XNPV"
            | "XIRR"
            // Phase 4.10 modern lookup fns (W5-169) — take ranges:
            | "XLOOKUP"
            | "XMATCH"
            // Phase 4.10 order-statistics fns (W5-D-11) — take 1
            // range:
            | "PERCENTILE.INC"
            | "PERCENTILE.EXC"
            | "PERCENTILE"
            | "QUARTILE.INC"
            | "QUARTILE.EXC"
            | "QUARTILE"
            // Phase 4.10 conditional aggregates / text join
            // (W5-65-ish, W5-167):
            | "MINIFS"
            | "MAXIFS"
            | "COUNTBLANK"
            | "TEXTJOIN"
    )
}

/// **W5-RT-1 (RT-V1-01):** classifier for the reference-aware dispatch tier.
/// These functions take their args under `BindContext::ReferenceArg` rather
/// than `Scalar` or `AggregateArg`. ReferenceArg context accepts:
///
/// - `Expr::CellRef` → `ExprPlan::CellRef` (unchanged).
/// - `Expr::RangeRef` → `ExprPlan::RangeRef { range }` (NEW; the only context
///   that accepts literal ranges at bind time today).
/// - `Expr::NameRef` resolving to a `NamedTarget::Range` →
///   `ExprPlan::AggregateNameRef` (same as `AggregateArg` semantics).
/// - `Expr::Array(_)` → `ExprPlan::Array(_)` for `ROWS({1,2,3;4,5,6})`.
/// - Everything else → bound as Scalar sub-expression (the per-fn impl
///   surfaces `#VALUE!` / `#N/A` for non-reference args per Excel canon).
///
/// **Step 2.1 (S2-MED-α closure):** pinned by two invariant tests:
///
/// - `accepts_special_arg_lists_only_registered_reference_aware_matcher_pin`
///   (this module's test mod) — every name the matcher returns true for
///   must be in the design's enumeration; typo guard. Direction:
///   matcher → list-of-7.
/// - `step_2_reference_aware_names_registered_in_reference_tier` —
///   registry-side: every Step 2 / 3 / 4 currently-registered
///   reference-aware fn must be recognized by the matcher AND
///   disjointly NOT resolve in any other tier. Direction: registry →
///   matcher. Currently covers 4 of 7 (ROW/COLUMN/ROWS/COLUMNS via
///   W5-RT-2 Step 2); extends as Step 3 (ISREF/ISFORMULA) and Step 4
///   (FORMULATEXT) ship. The matcher pre-lists all 7 by design so the
///   binder routing is stable as registrations land.
pub(crate) fn is_reference_aware_function(name: &str) -> bool {
    matches!(
        name,
        "ROW" | "COLUMN" | "ROWS" | "COLUMNS" | "ISREF" | "ISFORMULA" | "FORMULATEXT"
    )
}

/// Resolve an Expr against an owning sheet, producing an ExprPlan. **No name
/// resolution + no sheet resolution** — any `Expr::NameRef` produces
/// `BindError::UnresolvedName`; any cross-sheet ref (`SheetRef::Name`)
/// produces `BindError::UnknownSheet`.
///
/// `owning_sheet` is the sheet the formula lives on.
pub fn bind(expr: &Expr, owning_sheet: SheetId) -> Result<ExprPlan, BindError> {
    bind_with_names_and_sheets(expr, owning_sheet, &EmptyNameLookup, &EmptySheetResolver)
}

/// Phase 2A.1 — bind with a name resolver. **W5-90 update**: this entry
/// point uses an `EmptySheetResolver`, so cross-sheet refs surface as
/// `BindError::UnknownSheet`. Callers that need cross-sheet support
/// should use [`bind_with_names_and_sheets`] and pass a real
/// [`SheetResolver`] (typically `&Workbook` via the blanket impl).
pub fn bind_with_names<L: NameLookup>(
    expr: &Expr,
    owning_sheet: SheetId,
    names: &L,
) -> Result<ExprPlan, BindError> {
    bind_with_names_and_sheets(expr, owning_sheet, names, &EmptySheetResolver)
}

/// **W5-90 (Phase 4.6.B):** bind with BOTH name and sheet resolvers.
/// Production callers (`WorkbookRuntime`, `WorkbookTransaction`,
/// `CalcgraphSession`) pass `self.workbook.names()` for `names` and
/// `self.workbook` for `sheets` (the blanket `SheetResolver for
/// Workbook` impl in `env.rs` does the lookup via
/// `Workbook::sheet_id_by_name`).
///
/// **Phase 4.8.E note:** prefer [`bind_with_site`] for new code — it
/// carries the formula's owning cell (needed by 4.8.F's structured-ref
/// `[@Col]` resolution). This sheet-only entry point remains for
/// callers that don't have cell context (pure-syntax tests, parse
/// fuzzers) and constructs a `BindSite` with `cell: None` internally.
pub fn bind_with_names_and_sheets<L: NameLookup>(
    expr: &Expr,
    owning_sheet: SheetId,
    names: &L,
    sheets: &dyn SheetResolver,
) -> Result<ExprPlan, BindError> {
    bind_with_site_no_tables(
        expr,
        BindSite {
            sheet: owning_sheet,
            cell: None,
        },
        names,
        sheets,
    )
}

/// **W5-114 (Phase 4.8.E):** the formula's bind context — sheet plus
/// optionally the cell address. The cell is required for structured-
/// reference `[@Col]` resolution (4.8.F); other bind paths ignore it.
///
/// `cell: None` is allowed for parse-only / syntax-validation paths
/// where no specific cell is being bound; structured-ref `[@Col]`
/// surfaces `BindError::ThisRowRequiresOwningCell` in that case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BindSite {
    pub sheet: SheetId,
    pub cell: Option<ql_types::Address>,
}

impl BindSite {
    /// Construct a BindSite with no cell context (for parse-only paths).
    pub fn sheet_only(sheet: SheetId) -> Self {
        Self { sheet, cell: None }
    }

    /// Construct a BindSite with full cell context.
    pub fn at_cell(addr: ql_types::Address) -> Self {
        Self {
            sheet: addr.sheet,
            cell: Some(addr),
        }
    }
}

/// **W5-114 (Phase 4.8.E) / W5-115 (Phase 4.8.F):** bind with explicit
/// `BindSite` context. Used by production call sites. 4.8.F adds the
/// `tables` parameter for `Expr::StructuredRef` resolution; legacy
/// callers can use [`bind_with_site_no_tables`] which supplies an
/// `EmptyTableLookup` (any structured ref surfaces
/// `BindError::UnknownTable`).
pub fn bind_with_site<L: NameLookup>(
    expr: &Expr,
    site: BindSite,
    names: &L,
    sheets: &dyn SheetResolver,
    tables: &dyn TableLookup,
) -> Result<ExprPlan, BindError> {
    bind_with_context_v2(expr, site, names, sheets, tables, BindContext::Scalar)
}

/// **W5-115 (Phase 4.8.F):** convenience wrapper for legacy call sites
/// that don't have access to a `TableLookup`. Equivalent to
/// `bind_with_site(.., &EmptyTableLookup)` — any `Expr::StructuredRef`
/// surfaces `BindError::UnknownTable`.
pub fn bind_with_site_no_tables<L: NameLookup>(
    expr: &Expr,
    site: BindSite,
    names: &L,
    sheets: &dyn SheetResolver,
) -> Result<ExprPlan, BindError> {
    bind_with_site(expr, site, names, sheets, &EmptyTableLookup)
}

#[allow(dead_code)]
fn bind_with_context<L: NameLookup>(
    expr: &Expr,
    owning_sheet: SheetId,
    names: &L,
    sheets: &dyn SheetResolver,
    ctx: BindContext,
) -> Result<ExprPlan, BindError> {
    // 4.8.F: legacy entry — no table resolver, no cell context.
    bind_with_context_v2(
        expr,
        BindSite::sheet_only(owning_sheet),
        names,
        sheets,
        &EmptyTableLookup,
        ctx,
    )
}

fn bind_with_context_v2<L: NameLookup>(
    expr: &Expr,
    site: BindSite,
    names: &L,
    sheets: &dyn SheetResolver,
    tables: &dyn TableLookup,
    ctx: BindContext,
) -> Result<ExprPlan, BindError> {
    let owning_sheet = site.sheet;
    match expr {
        Expr::Number(n) => Ok(ExprPlan::Number(*n)),
        Expr::Bool(b) => Ok(ExprPlan::Bool(*b)),
        Expr::String(s) => Ok(ExprPlan::String(s.clone())),
        Expr::CellRef(addr) => Ok(ExprPlan::CellRef {
            sheet: resolve_sheet_ref(&addr.sheet, owning_sheet, sheets)?,
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
            lhs: Box::new(bind_with_context_v2(
                lhs,
                site,
                names,
                sheets,
                tables,
                BindContext::Scalar,
            )?),
            rhs: Box::new(bind_with_context_v2(
                rhs,
                site,
                names,
                sheets,
                tables,
                BindContext::Scalar,
            )?),
        }),
        Expr::Unary { op, operand } => Ok(ExprPlan::Unary {
            op: *op,
            operand: Box::new(bind_with_context_v2(
                operand,
                site,
                names,
                sheets,
                tables,
                BindContext::Scalar,
            )?),
        }),
        Expr::RangeRef(rr) => {
            // **W5-RT-1 (RT-V1-01):** literal range args are accepted inside
            // a reference-aware function arg list (`BindContext::ReferenceArg`)
            // — they lower to `ExprPlan::RangeRef { range }`. Outside that
            // context the rejection stands (W5-108 / Phase 4.7.O message
            // preserved).
            //
            // AggregateArg-side enabling (which would let `SUM(A1:B3)` bind)
            // is deferred: every Scalar/RangeAware/Unified dispatcher arm
            // would also need new `ExprPlan::RangeRef` handling, which is
            // out of scope for the reference-tier mini-phase. Tracked as a
            // follow-up in the design doc § 5.4.
            if ctx == BindContext::ReferenceArg {
                let range = resolve_range_ref_to_range(rr, owning_sheet, sheets)?;
                Ok(ExprPlan::RangeRef { range })
            } else {
                Err(BindError::UnsupportedVariant(
                    "literal RangeRef in non-Function context is unsupported in v1; \
                     use a named range (Phase 2B.4 AggregateNameRef) or wrap in an \
                     aggregate function. (Updated W5-108 / Phase 4.7.O; original \
                     Phase 0 W4-1 message referenced \"no function dispatch yet\" \
                     which has been in place since Phase 2A. W5-RT-1 added literal \
                     RangeRef support inside reference-aware fn arg lists only.)",
                ))
            }
        }
        Expr::Function { name, args } => {
            // **W5-RT-1 (RT-V1-01):** reference-aware fns take args under
            // `ReferenceArg` context (literal RangeRef + range NameRef both
            // accepted; CellRef passes through). Aggregate/range-aware/
            // unified-tier fns keep the existing `AggregateArg` context.
            // Plain scalar fns get `Scalar` (rejects range args).
            let arg_ctx = if is_reference_aware_function(name) {
                BindContext::ReferenceArg
            } else if is_aggregate_function(name) {
                BindContext::AggregateArg
            } else {
                BindContext::Scalar
            };
            let mut bound_args = Vec::with_capacity(args.len());
            for a in args {
                bound_args.push(bind_with_context_v2(
                    a, site, names, sheets, tables, arg_ctx,
                )?);
            }
            Ok(ExprPlan::Function {
                name: name.clone(),
                args: bound_args,
            })
        }
        // **W5-99 (Phase 4.7.F):** lower `Expr::Array` to
        // `ExprPlan::Array`. Per design § 5, this is element-wise +
        // enforces uniform row arity AND the restricted cell-kind subset
        // (Number / Bool / String / Error). The parser already validates
        // both; this is defense in depth against direct AST construction.
        Expr::Array(rows) => {
            // **W5-99 closure (Codex MEDIUM-7 / Sonnet L-1):** reject
            // degenerate shapes — zero rows OR zero cells in row 0.
            // The parser rejects `{}` via `ParseError::EmptyArrayLiteral`,
            // but `Expr::Array(vec![])` and `Expr::Array(vec![vec![]])`
            // are directly-constructible; the latter would otherwise
            // bind with `expected_arity = 0` and produce a degenerate
            // ExprPlan::Array(vec![vec![]]) that downstream code would
            // need a special case for.
            if rows.is_empty() || rows[0].is_empty() {
                return Err(BindError::EmptyArrayLiteral);
            }
            let expected_arity = rows[0].len() as u32;
            let mut bound_rows: Vec<Vec<ExprPlan>> = Vec::with_capacity(rows.len());
            for (row_idx, row) in rows.iter().enumerate() {
                let found_arity = row.len() as u32;
                if found_arity != expected_arity {
                    return Err(BindError::ArrayRowArityMismatch {
                        expected: expected_arity,
                        found: found_arity,
                        row: row_idx as u32,
                    });
                }
                let mut bound_row: Vec<ExprPlan> = Vec::with_capacity(row.len());
                for (col_idx, cell) in row.iter().enumerate() {
                    let bound_cell = match cell {
                        Expr::Number(n) => ExprPlan::Number(*n),
                        Expr::Bool(b) => ExprPlan::Bool(*b),
                        Expr::String(s) => ExprPlan::String(s.clone()),
                        Expr::Error(ev) => ExprPlan::Error(*ev),
                        // Per design § 3.3 / parser restriction: only the
                        // four literal kinds are allowed inside an array
                        // cell. Reject everything else loudly so a future
                        // test that constructs `Expr::Array(vec![vec![
                        // Expr::CellRef(_)]])` directly surfaces a clean
                        // error rather than silently producing a corrupt
                        // ExprPlan.
                        other => {
                            return Err(BindError::ArrayCellNotLiteral {
                                row: row_idx as u32,
                                col: col_idx as u32,
                                got: variant_kind(other),
                            });
                        }
                    };
                    bound_row.push(bound_cell);
                }
                bound_rows.push(bound_row);
            }
            Ok(ExprPlan::Array(bound_rows))
        }

        Expr::Spill(_) => Err(BindError::UnsupportedVariant(
            "Spill-range-ref `A1#` syntax is Phase 4.9",
        )),

        // **W5-99 (Phase 4.7.F):** error literal — mechanical lowering.
        // No resolution, no context. The evaluator returns
        // `Value::Error(ev)` directly.
        Expr::Error(ev) => Ok(ExprPlan::Error(*ev)),
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
            match names.lookup_named_target(name, owning_sheet) {
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
                // W5-RT-1 (RT-V1-01): reference-aware fn arg context
                // accepts named ranges with the same shape as aggregate
                // arg — the materializer treats `AggregateNameRef` as a
                // `RefArg::Range` consumer.
                Some(ResolvedName::Range(range)) => match ctx {
                    BindContext::AggregateArg | BindContext::ReferenceArg => {
                        Ok(ExprPlan::AggregateNameRef {
                            name: name.clone(),
                            range,
                        })
                    }
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
        // **W5-115 (Phase 4.8.F):** resolve structured ref against
        // TableLookup. The `[@Col]` form returns a column-wide range
        // plus `is_this_row: true`; eval narrows to a single cell.
        Expr::StructuredRef { table_name, spec } => {
            resolve_structured_ref(table_name, spec, tables)
        }
        // **W5-140 (Phase 4.9.C binder):** lower the intermediate
        // R1C1 reference to an absolute `ExprPlan::CellRef`.
        // Absolute axes (`AxisSpec::Abs(n)`) drop straight in as
        // 0-indexed `n - 1` (R1C1 is 1-indexed in source per Excel
        // canon; both axis bounds are already enforced at lex time
        // and re-checked here for defense-in-depth). Relative axes
        // (`AxisSpec::Rel(offset)`) resolve against the formula's
        // anchor cell from `site.cell`; without a cell anchor we
        // fail with `BindError::R1C1RequiresAnchor` rather than
        // silently substituting `Address::ORIGIN`.
        //
        // `abs_col` / `abs_row` flags on the resulting `CellRef`
        // are derived from the source axis: `Abs(_)` → true,
        // `Rel(_)` → false. This is exactly what the printer will
        // need at 4.9.D to re-emit canonical A1 (with `$`
        // prefixes) vs R1C1 (with brackets), and the canonical-
        // storage flow at 4.9.K relies on it.
        Expr::R1C1Ref {
            sheet,
            row_axis,
            col_axis,
        } => {
            let anchor_row = site.cell.map(|a| a.row);
            let anchor_col = site.cell.map(|a| a.col);
            let row = resolve_r1c1_axis(*row_axis, anchor_row, R1C1Axis::Row)?;
            let col = resolve_r1c1_axis(*col_axis, anchor_col, R1C1Axis::Col)?;
            Ok(ExprPlan::CellRef {
                sheet: resolve_sheet_ref(sheet, owning_sheet, sheets)?,
                row,
                col,
                abs_col: matches!(col_axis, AxisSpec::Abs(_)),
                abs_row: matches!(row_axis, AxisSpec::Abs(_)),
            })
        }
        // **W5-144 (Phase 4.9.H):** implicit-intersection binding.
        // Strategy: narrow at BIND TIME wherever the inner shape
        // allows it, dropping the wrapper. The AST keeps
        // `Expr::ImplicitIntersection` for round-trip print (per
        // design § 4.2 "NOT surface-only"); the ExprPlan never
        // needs a parallel variant because every reachable narrow
        // case collapses to a normal ExprPlan shape.
        //
        // Narrowing rules per design § 3.3 (anchor = `site.cell`):
        //   1. Scalar / CellRef inner → drop wrapper.
        //   2. Bounded range, single column → narrow to anchor row.
        //   3. Bounded range, single row → narrow to anchor col.
        //   4. Bounded range, 2-D → `ExprPlan::Error(#VALUE!)`.
        //   5. Single-cell range (`A1:A1`) → idempotent single cell.
        //   6. WholeColumn / WholeRow → narrow to anchor.
        //   7. Array literal inner → top-left.
        //   8. Function inner → keep as-is (scalar return passes
        //      through; array return → `#CALC!` per existing scalar
        //      eval limit, known gap).
        //   9. StructuredRef inner → patch `is_this_row: true` on
        //      the resolved range so eval narrows to formula row
        //      (matches `=Sales[@Qty]` semantics).
        //  10. NameRef resolving to Range → resolve, narrow if
        //      possible, error if 2-D.
        //
        // Out-of-range narrow → `BindError::UnsupportedVariant` to
        // become #VALUE! at eval time (we surface as ExprPlan::Error
        // so the cell value is the right ErrorValue without runtime
        // dispatch overhead).
        Expr::ImplicitIntersection(inner) => bind_implicit_intersection(
            inner.as_ref(),
            owning_sheet,
            site,
            names,
            sheets,
            tables,
            ctx,
        ),
    }
}

/// **W5-144 (Phase 4.9.H):** narrow `@expr` at bind time per design
/// § 3.3. Returns an `ExprPlan` with the wrapper dropped (every
/// reachable case collapses to an existing ExprPlan shape).
fn bind_implicit_intersection<L: NameLookup>(
    inner: &Expr,
    owning_sheet: SheetId,
    site: BindSite,
    names: &L,
    sheets: &dyn SheetResolver,
    tables: &dyn TableLookup,
    ctx: BindContext,
) -> Result<ExprPlan, BindError> {
    match inner {
        // Rule 1 / 5: scalar inputs pass through unchanged. CellRef
        // is already a single cell (rule 5 — idempotent).
        Expr::Number(_)
        | Expr::Bool(_)
        | Expr::String(_)
        | Expr::Error(_)
        | Expr::CellRef(_)
        | Expr::R1C1Ref { .. }
        | Expr::Unary { .. }
        | Expr::Binary { .. }
        | Expr::NameRef(_) => bind_with_context_v2(inner, site, names, sheets, tables, ctx),

        // Rule 8: function inner. The `@` is semantically a no-op for
        // scalar function returns (most common case). Array returns
        // currently surface as `#CALC!` in scalar context per existing
        // 4.7.G limit; the design § 3.3 rule 7 "array → top-left" is
        // a known v1 gap (deferred to cell-boundary spill rewiring).
        Expr::Function { .. } => bind_with_context_v2(inner, site, names, sheets, tables, ctx),

        // Rule 7: array literal → top-left.
        Expr::Array(rows) => {
            if rows.is_empty() || rows[0].is_empty() {
                return Err(BindError::EmptyArrayLiteral);
            }
            // Bind the top-left cell as a standalone scalar.
            bind_with_context_v2(
                &rows[0][0],
                site,
                names,
                sheets,
                tables,
                BindContext::Scalar,
            )
        }

        // Rules 2 / 3 / 4 / 5 / 6: range narrowing using site.cell.
        Expr::RangeRef(rr) => {
            narrow_range_for_implicit_intersection(rr, owning_sheet, site, sheets)
        }

        // Rule 9: structured ref. Bind via the normal path, then
        // override `is_this_row: true` ONLY when the spec is a
        // single column reference (`BareColumn`) — making
        // `@Sales[Qty]` ≡ `Sales[@Qty]` at eval time.
        //
        // **W5-151 (4.9.O MEDIUM-1 closure):** the prior version
        // forced `is_this_row: true` unconditionally, which broke:
        //   - `@Sales[[#Headers], [Qty]]` — single header cell
        //     ought to be idempotent (rule 5), but unconditional
        //     `is_this_row` would narrow it to formula row →
        //     `#VALUE!` for any formula not in the header row.
        //   - `@Sales[#All]` / multi-column refs — semantics differ;
        //     resolve_structured_ref already returns `is_this_row:
        //     true` for `ThisRowColumn`/`ThisRowColumnRange` and
        //     `false` for the special-form combinations that
        //     resolve to single cells / multi-axis ranges. The
        //     `@` operator should respect that classification, not
        //     force-override.
        //
        // Discrimination is by spec shape:
        //   - `BareColumn(_)` → @ overrides to true (the load-bearing
        //     `=@Sales[Qty]` case).
        //   - `ThisRowColumn(_)` → resolve_structured_ref already set
        //     `is_this_row: true`. @ is idempotent.
        //   - `ThisRowColumnRange(_, _)` → same, already true.
        //   - `Combination(_)` → pass through what resolve returned
        //     (`true` if `#This Row` is in the items, else `false`).
        Expr::StructuredRef { table_name, spec } => {
            use ql_formula_syntax::TableSpecSubtree;
            let plan = resolve_structured_ref(table_name, spec, tables)?;
            // Only override when @ wraps a bare column reference.
            let is_bare_column = matches!(spec, TableSpecSubtree::BareColumn(_));
            match plan {
                ExprPlan::StructuredRef {
                    table_name,
                    source,
                    resolved,
                    is_this_row,
                } => Ok(ExprPlan::StructuredRef {
                    table_name,
                    source,
                    resolved,
                    is_this_row: if is_bare_column { true } else { is_this_row },
                }),
                // resolve_structured_ref only ever returns
                // ExprPlan::StructuredRef; the wildcard arm is
                // defensive.
                other => Ok(other),
            }
        }

        // Nested `@@expr` — Excel-canon idempotent. Strip outer
        // wrapper; recurse on the inner ImplicitIntersection.
        Expr::ImplicitIntersection(_) => {
            bind_with_context_v2(inner, site, names, sheets, tables, ctx)
        }

        // Spill-range syntax (`A1#`) is reserved for a future Phase.
        // NOTE: Phase 4.9 closed without adding `A1#` parsing — this
        // arm guards future addition (closes 4.9.O Sonnet LOW-1 doc
        // drift).
        Expr::Spill(_) => Err(BindError::UnsupportedVariant(
            "Spill-range-ref `A1#` inside `@` is unsupported in v1; \
             the design § 3.3 rule for `@A1#` is documented but the \
             eval-side spill-range expansion is deferred.",
        )),
    }
}

/// **W5-144 (Phase 4.9.H):** apply design § 3.3 rules 2-6 to a
/// `RangeRef` inner with a formula-cell anchor (`site.cell`).
fn narrow_range_for_implicit_intersection(
    rr: &ql_formula_syntax::RangeRef,
    owning_sheet: SheetId,
    site: BindSite,
    sheets: &dyn SheetResolver,
) -> Result<ExprPlan, BindError> {
    use ql_formula_syntax::RangeRef;
    let anchor = site
        .cell
        .ok_or(BindError::ImplicitIntersectionRequiresAnchor)?;
    match rr {
        RangeRef::Cells {
            sheet,
            start_col,
            start_row,
            end_col,
            end_row,
            abs_start_col,
            abs_start_row,
            abs_end_col: _,
            abs_end_row: _,
        } => {
            let sheet_id = resolve_sheet_ref(sheet, owning_sheet, sheets)?;
            let single_col = start_col == end_col;
            let single_row = start_row == end_row;
            match (single_col, single_row) {
                // Rule 5: single cell — idempotent.
                (true, true) => Ok(ExprPlan::CellRef {
                    sheet: sheet_id,
                    row: *start_row,
                    col: *start_col,
                    abs_col: *abs_start_col,
                    abs_row: *abs_start_row,
                }),
                // Rule 2: single column.
                (true, false) => {
                    if anchor.row >= *start_row && anchor.row <= *end_row {
                        Ok(ExprPlan::CellRef {
                            sheet: sheet_id,
                            row: anchor.row,
                            col: *start_col,
                            // Narrowed coord is row-dependent (formula-row);
                            // the original abs flag on the col axis stays.
                            abs_col: *abs_start_col,
                            abs_row: false,
                        })
                    } else {
                        Ok(ExprPlan::Error(ErrorValue::Value))
                    }
                }
                // Rule 3: single row.
                (false, true) => {
                    if anchor.col >= *start_col && anchor.col <= *end_col {
                        Ok(ExprPlan::CellRef {
                            sheet: sheet_id,
                            row: *start_row,
                            col: anchor.col,
                            abs_col: false,
                            abs_row: *abs_start_row,
                        })
                    } else {
                        Ok(ExprPlan::Error(ErrorValue::Value))
                    }
                }
                // Rule 4: 2-D → ALWAYS #VALUE!.
                (false, false) => Ok(ExprPlan::Error(ErrorValue::Value)),
            }
        }
        // Rule 6: whole column — narrow to anchor row.
        RangeRef::WholeColumn {
            sheet,
            start_col,
            end_col,
            abs_start,
            ..
        } => {
            let sheet_id = resolve_sheet_ref(sheet, owning_sheet, sheets)?;
            if start_col == end_col {
                // Single column — narrow to anchor row.
                Ok(ExprPlan::CellRef {
                    sheet: sheet_id,
                    row: anchor.row,
                    col: *start_col,
                    abs_col: *abs_start,
                    abs_row: false,
                })
            } else {
                // Multi-column whole-column form (e.g. `A:C`) is
                // semantically a 2-D range under `@` → #VALUE!.
                Ok(ExprPlan::Error(ErrorValue::Value))
            }
        }
        // Rule 6: whole row — narrow to anchor col.
        RangeRef::WholeRow {
            sheet,
            start_row,
            end_row,
            abs_start,
            ..
        } => {
            let sheet_id = resolve_sheet_ref(sheet, owning_sheet, sheets)?;
            if start_row == end_row {
                Ok(ExprPlan::CellRef {
                    sheet: sheet_id,
                    row: *start_row,
                    col: anchor.col,
                    abs_col: false,
                    abs_row: *abs_start,
                })
            } else {
                Ok(ExprPlan::Error(ErrorValue::Value))
            }
        }
        // R1C1Cells is parser-intermediate — storage canon lowers
        // before bind. Reaching here means canonicalization was
        // bypassed.
        RangeRef::R1C1Cells { .. } => Err(BindError::UnsupportedVariant(
            "RangeRef::R1C1Cells inside @ is parser-intermediate; storage canon \
             must lower to absolute Cells before bind.",
        )),
    }
}

/// **W5-140 (Phase 4.9.C binder):** which axis is being resolved —
/// selects bounds and the bounds-error field shape.
#[derive(Clone, Copy)]
enum R1C1Axis {
    Row,
    Col,
}

/// **W5-140 (Phase 4.9.C binder):** resolve one R1C1 axis to a
/// 0-indexed `u32` coordinate.
///
/// - `Abs(n)`: returns `n - 1`. `n` is validated to be `1..=MAX+1`
///   (lex-time check + binder defense-in-depth). `n == 0` should
///   never reach here (lexer rejects it as `MalformedR1C1`); if it
///   does, we surface `R1C1OutOfBounds` rather than panicking.
/// - `Rel(offset)`: returns `anchor + offset` if `anchor.is_some()`
///   and the sum is in-grid. `anchor.is_none()` →
///   `R1C1RequiresAnchor`. Out-of-grid → `R1C1OutOfBounds`. The
///   intermediate sum is computed in `i64` so we can both detect
///   overflow AND surface the offending negative coord in the
///   error (rather than wrapping silently).
fn resolve_r1c1_axis(
    axis: AxisSpec,
    anchor: Option<u32>,
    which: R1C1Axis,
) -> Result<u32, BindError> {
    let bound = match which {
        R1C1Axis::Row => MAX_ROW,
        R1C1Axis::Col => MAX_COLUMN,
    };
    match axis {
        AxisSpec::Abs(n) => {
            if n == 0 || n > bound + 1 {
                return Err(BindError::R1C1OutOfBounds {
                    resolved_row: matches!(which, R1C1Axis::Row).then_some(n as i64 - 1),
                    resolved_col: matches!(which, R1C1Axis::Col).then_some(n as i64 - 1),
                });
            }
            Ok(n - 1)
        }
        AxisSpec::Rel(offset) => {
            let Some(anchor) = anchor else {
                return Err(BindError::R1C1RequiresAnchor);
            };
            let resolved = anchor as i64 + offset as i64;
            if resolved < 0 || resolved > bound as i64 {
                return Err(BindError::R1C1OutOfBounds {
                    resolved_row: matches!(which, R1C1Axis::Row).then_some(resolved),
                    resolved_col: matches!(which, R1C1Axis::Col).then_some(resolved),
                });
            }
            Ok(resolved as u32)
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

/// Name-resolution interface. `ql-exec` stays decoupled from `ql-storage`;
/// the production caller wires a `Workbook` through this trait.
///
/// **W5-92 (Phase 4.6.D):** the trait now takes `owning_sheet` so impls
/// that hold scoped tables (the `Workbook` blanket impl in
/// `env.rs`) can run the two-tier chain: sheet-scoped first, then
/// workbook-scoped. Impls without a sheet axis (legacy
/// `NameLookup for NameTable`, `EmptyNameLookup`) ignore the parameter.
pub trait NameLookup {
    fn lookup_named_target(&self, name: &str, owning_sheet: SheetId) -> Option<ResolvedName>;
}

/// Default empty-lookup resolver used by the legacy `bind()` entry point. Always
/// returns `None`, so any NameRef becomes `BindError::UnresolvedName`.
struct EmptyNameLookup;

impl NameLookup for EmptyNameLookup {
    fn lookup_named_target(&self, _name: &str, _owning_sheet: SheetId) -> Option<ResolvedName> {
        None
    }
}

/// **W5-90 (Phase 4.6.B):** sheet-name resolution interface. Mirrors
/// `NameLookup`: `ql-exec` stays decoupled from `ql-storage`; the
/// production caller wires a `Workbook` through this trait. Used by
/// the binder to resolve `SheetRef::Name(N)` → `SheetRef::Id(id)`.
///
/// Lookup contract: case-insensitive (per `Workbook::canonical_sheet_name`).
pub trait SheetResolver {
    fn resolve_sheet(&self, name: &str) -> Option<SheetId>;
}

/// Default empty-resolver. Used by the legacy `bind()` / `bind_with_names()`
/// entry points: any cross-sheet ref surfaces as `BindError::UnknownSheet`.
pub(crate) struct EmptySheetResolver;

impl SheetResolver for EmptySheetResolver {
    fn resolve_sheet(&self, _name: &str) -> Option<SheetId> {
        None
    }
}

/// **W5-115 (Phase 4.8.F):** table-metadata lookup interface. Mirrors
/// [`NameLookup`] / [`SheetResolver`]: `ql-exec` stays decoupled from
/// `ql-storage`; production callers wire `Workbook` (via the blanket
/// impl in `env.rs`). Used by the binder to resolve
/// `Expr::StructuredRef { table_name, spec }` → `ExprPlan::StructuredRef
/// { resolved: Range, ... }`.
///
/// Lookup contract: case-insensitive on the canonical-uppercase form
/// (mirrors `TableTable::lookup`).
pub trait TableLookup {
    /// Resolve a table name to its metadata, or `None` if not registered.
    fn lookup_table(&self, name: &str) -> Option<&ql_storage::TableMetadata>;
}

/// Default empty-resolver. Used by the legacy `bind()` / test entry
/// points: any structured ref surfaces as
/// `BindError::UnknownTable(name)`.
pub(crate) struct EmptyTableLookup;

impl TableLookup for EmptyTableLookup {
    fn lookup_table(&self, _name: &str) -> Option<&ql_storage::TableMetadata> {
        None
    }
}

/// **W5-99 (Phase 4.7.F):** human-readable variant tag for the
/// `ArrayCellNotLiteral` error message. Used only on the error
/// path so the cost is irrelevant.
/// **W5-115 (Phase 4.8.F):** resolve a parsed structured reference
/// against the table registry. Produces `ExprPlan::StructuredRef`
/// with a concrete `Range` (eval reads this) plus a flag indicating
/// whether the row needs per-cell narrowing (`[@Col]` forms).
///
/// Resolution rules per design § 7.2:
/// - `BareColumn(col)` → column's data range (rows excluding
///   header/totals).
/// - `Combination([...])` — normalize to a single (row selector,
///   column selector) intersection. Multiple `Special` items combine
///   as union over rows; multiple `Column` items must be contiguous
///   (Excel canon — no gappy ranges). Currently supports the common
///   forms: single Special, single Column, single ColumnRange,
///   `[#Special], [Col]`, `[#Special], [Col1]:[Col2]`. Multi-Special
///   combinations like `[#Headers], [#Data]` lower to a single union
///   range when possible (e.g., `headers ∪ data` = `all - totals`).
/// - `ThisRowColumn(col)` / `ThisRowColumnRange(c1, c2)` → column's
///   full data range with `is_this_row: true`. Eval narrows.
fn resolve_structured_ref(
    table_name: &Arc<str>,
    spec: &ql_formula_syntax::TableSpecSubtree,
    tables: &dyn TableLookup,
) -> Result<ExprPlan, BindError> {
    use ql_formula_syntax::TableSpecSubtree;
    let table = tables
        .lookup_table(table_name.as_ref())
        .ok_or_else(|| BindError::UnknownTable(Arc::clone(table_name)))?;
    let canonical_name = Arc::clone(&table.name);
    // Helper closures for the common error paths.
    let unknown_column = |col: &Arc<str>| BindError::UnknownTableColumn {
        table: Arc::clone(&canonical_name),
        column: Arc::clone(col),
    };

    let (resolved, is_this_row) = match spec {
        TableSpecSubtree::BareColumn(col) => {
            let (idx, _) = table
                .lookup_column(col)
                .ok_or_else(|| unknown_column(col))?;
            let range = table.column_data_range(idx).ok_or_else(|| {
                BindError::StructuredRefDegenerateRange(Arc::clone(&canonical_name))
            })?;
            (range, false)
        }
        TableSpecSubtree::ThisRowColumn(col) => {
            let (idx, _) = table
                .lookup_column(col)
                .ok_or_else(|| unknown_column(col))?;
            // Eval narrows to one cell; binder hands back the full data
            // column. If the column has no data rows, the eval narrow
            // returns degenerate → cell-boundary maps to #VALUE!
            // (handled at 4.8.G).
            let range = table.column_data_range(idx).ok_or_else(|| {
                BindError::StructuredRefDegenerateRange(Arc::clone(&canonical_name))
            })?;
            (range, true)
        }
        TableSpecSubtree::ThisRowColumnRange(c1, c2) => {
            let (i1, _) = table.lookup_column(c1).ok_or_else(|| unknown_column(c1))?;
            let (i2, _) = table.lookup_column(c2).ok_or_else(|| unknown_column(c2))?;
            let lo = i1.min(i2);
            let hi = i1.max(i2);
            let r1 = table.column_data_range(lo).ok_or_else(|| {
                BindError::StructuredRefDegenerateRange(Arc::clone(&canonical_name))
            })?;
            let r2 = table.column_data_range(hi).ok_or_else(|| {
                BindError::StructuredRefDegenerateRange(Arc::clone(&canonical_name))
            })?;
            (
                Range::new(r1.sheet, r1.start_row, r1.start_col, r2.end_row, r2.end_col),
                true,
            )
        }
        TableSpecSubtree::Combination(items) => {
            resolve_sref_combination(&canonical_name, table, items)?
        }
    };

    Ok(ExprPlan::StructuredRef {
        table_name: canonical_name,
        source: Arc::new(spec.clone()),
        resolved,
        is_this_row,
    })
}

/// **W5-115 (Phase 4.8.F):** resolve a `Combination` spec to a single
/// row-selector × column-selector range. Common forms:
/// - `[#All]` → full footprint.
/// - `[#Headers]` → header row across all columns.
/// - `[#Totals]` → totals row.
/// - `[#Data]` → data rows.
/// - `[Col]` → single column data.
/// - `[Col1]:[Col2]` → column range data.
/// - `[#Special], [Col]` → intersection (e.g. `[#Headers], [Qty]` →
///   header cell of Qty column).
/// - `[#Special], [Col1]:[Col2]` → intersection over column range.
fn resolve_sref_combination(
    canonical: &Arc<str>,
    table: &ql_storage::TableMetadata,
    items: &[ql_formula_syntax::TableSpecItem],
) -> Result<(Range, bool), BindError> {
    use ql_formula_syntax::{SpecialItem, TableSpecItem};

    // Walk items: gather special items (row selectors) and column items.
    let mut row_selectors: Vec<SpecialItem> = Vec::new();
    let mut col_items: Vec<&TableSpecItem> = Vec::new();
    for it in items {
        match it {
            TableSpecItem::Special(s) => row_selectors.push(*s),
            other => col_items.push(other),
        }
    }

    // Compute the row range.
    let row_range = compute_row_range(canonical, table, &row_selectors)?;

    // Compute the column range.
    let col_range = compute_col_range(canonical, table, &col_items)?;

    // Intersect.
    let resolved = Range::new(
        table.sheet,
        row_range.0,
        col_range.0,
        row_range.1,
        col_range.1,
    );

    // `[[#This Row], [Col]]` → is_this_row. Detected by exactly one
    // ThisRow item in selectors. Eval narrows.
    let is_this_row = row_selectors.contains(&SpecialItem::ThisRow);

    Ok((resolved, is_this_row))
}

/// Resolve the row span from a list of `Special` items. Empty list
/// defaults to the data range (Excel canon for column-only specs).
fn compute_row_range(
    canonical: &Arc<str>,
    table: &ql_storage::TableMetadata,
    selectors: &[ql_formula_syntax::SpecialItem],
) -> Result<(ql_types::RowId, ql_types::RowId), BindError> {
    use ql_formula_syntax::SpecialItem;
    if selectors.is_empty() {
        let data = table
            .data_range()
            .ok_or_else(|| BindError::StructuredRefDegenerateRange(Arc::clone(canonical)))?;
        return Ok((data.start_row, data.end_row));
    }
    // Union over rows. The 5 selectors:
    let mut min_row: Option<ql_types::RowId> = None;
    let mut max_row: Option<ql_types::RowId> = None;
    let mut accumulate = |r: Range| {
        min_row = Some(min_row.map_or(r.start_row, |m| m.min(r.start_row)));
        max_row = Some(max_row.map_or(r.end_row, |m| m.max(r.end_row)));
    };
    for sel in selectors {
        let r = match sel {
            SpecialItem::Headers => table
                .header_range()
                .ok_or_else(|| BindError::TableHasNoHeader(Arc::clone(canonical)))?,
            SpecialItem::Totals => table
                .totals_range()
                .ok_or_else(|| BindError::TableHasNoTotals(Arc::clone(canonical)))?,
            SpecialItem::Data => table
                .data_range()
                .ok_or_else(|| BindError::StructuredRefDegenerateRange(Arc::clone(canonical)))?,
            SpecialItem::All => table.all_range(),
            SpecialItem::ThisRow => {
                // ThisRow as a row selector inside a Combination means
                // "the formula's current row". The binder defers actual
                // row resolution to eval time; here we hand back the
                // full data range and rely on the caller setting
                // is_this_row.
                table
                    .data_range()
                    .ok_or_else(|| BindError::StructuredRefDegenerateRange(Arc::clone(canonical)))?
            }
        };
        accumulate(r);
    }
    Ok((
        min_row.expect("at least one selector accumulated"),
        max_row.expect("at least one selector accumulated"),
    ))
}

/// Resolve the column span from a list of `Column` / `ColumnRange`
/// items. Empty list defaults to all columns.
fn compute_col_range(
    canonical: &Arc<str>,
    table: &ql_storage::TableMetadata,
    col_items: &[&ql_formula_syntax::TableSpecItem],
) -> Result<(ql_types::ColId, ql_types::ColId), BindError> {
    use ql_formula_syntax::TableSpecItem;
    if col_items.is_empty() {
        // All columns.
        return Ok((table.top_col, table.top_col + table.cols - 1));
    }
    let mut min_col: Option<ql_types::ColId> = None;
    let mut max_col: Option<ql_types::ColId> = None;
    for it in col_items {
        let (lo, hi) = match it {
            TableSpecItem::Column(col) => {
                let (idx, _) =
                    table
                        .lookup_column(col)
                        .ok_or_else(|| BindError::UnknownTableColumn {
                            table: Arc::clone(canonical),
                            column: Arc::clone(col),
                        })?;
                let c = table.top_col + idx;
                (c, c)
            }
            TableSpecItem::ColumnRange(c1, c2) => {
                let (i1, _) =
                    table
                        .lookup_column(c1)
                        .ok_or_else(|| BindError::UnknownTableColumn {
                            table: Arc::clone(canonical),
                            column: Arc::clone(c1),
                        })?;
                let (i2, _) =
                    table
                        .lookup_column(c2)
                        .ok_or_else(|| BindError::UnknownTableColumn {
                            table: Arc::clone(canonical),
                            column: Arc::clone(c2),
                        })?;
                let lo = i1.min(i2);
                let hi = i1.max(i2);
                (table.top_col + lo, table.top_col + hi)
            }
            TableSpecItem::Special(_) => unreachable!("special items filtered out by caller"),
        };
        min_col = Some(min_col.map_or(lo, |m| m.min(lo)));
        max_col = Some(max_col.map_or(hi, |m| m.max(hi)));
    }
    Ok((
        min_col.expect("at least one column accumulated"),
        max_col.expect("at least one column accumulated"),
    ))
}

fn variant_kind(e: &Expr) -> &'static str {
    match e {
        Expr::Number(_) => "Number",
        Expr::Bool(_) => "Bool",
        Expr::String(_) => "String",
        Expr::Error(_) => "Error",
        Expr::CellRef(_) => "CellRef",
        Expr::RangeRef(_) => "RangeRef",
        Expr::Binary { .. } => "Binary",
        Expr::Unary { .. } => "Unary",
        Expr::Function { .. } => "Function",
        Expr::Array(_) => "Array",
        Expr::Spill(_) => "Spill",
        Expr::NameRef(_) => "NameRef",
        Expr::StructuredRef { .. } => "StructuredRef",
        // **W5-139 (Phase 4.9.C):** intermediate R1C1 form.
        Expr::R1C1Ref { .. } => "R1C1Ref",
        // **W5-143 (Phase 4.9.G):**
        Expr::ImplicitIntersection(_) => "ImplicitIntersection",
    }
}

/// **W5-90 (Phase 4.6.B):** resolve a `SheetRef` for the binder.
///
/// - `Current` → `owning_sheet` (the formula's own sheet).
/// - `Id(s)` → `s` (already resolved; produced post-bind or by tests).
/// - `Name(n)` → lookup via `sheets.resolve_sheet(n)`; `None` →
///   `BindError::UnknownSheet`.
fn resolve_sheet_ref(
    sheet: &SheetRef,
    owning_sheet: SheetId,
    sheets: &dyn SheetResolver,
) -> Result<SheetId, BindError> {
    match sheet {
        SheetRef::Current => Ok(owning_sheet),
        SheetRef::Id(s) => Ok(*s),
        SheetRef::Name(n) => sheets
            .resolve_sheet(n)
            .ok_or_else(|| BindError::UnknownSheet(n.clone())),
    }
}

/// **W5-RT-1 (RT-V1-01):** resolve `Expr::RangeRef` to a [`Range`] WITHOUT
/// implicit-intersection narrowing. Used by the reference-aware binder path
/// for ROW/COLUMN/ROWS/COLUMNS args. Whole-column resolves to the full row
/// range `0..=MAX_ROW`, whole-row to `0..=MAX_COLUMN`. R1C1 cells inside `@`
/// is parser-intermediate (storage canon is A1) and is rejected here too.
fn resolve_range_ref_to_range(
    rr: &ql_formula_syntax::RangeRef,
    owning_sheet: SheetId,
    sheets: &dyn SheetResolver,
) -> Result<Range, BindError> {
    use ql_formula_syntax::RangeRef;
    match rr {
        RangeRef::Cells {
            sheet,
            start_col,
            start_row,
            end_col,
            end_row,
            ..
        } => {
            let sheet_id = resolve_sheet_ref(sheet, owning_sheet, sheets)?;
            Ok(Range::new(
                sheet_id, *start_row, *start_col, *end_row, *end_col,
            ))
        }
        RangeRef::WholeColumn {
            sheet,
            start_col,
            end_col,
            ..
        } => {
            let sheet_id = resolve_sheet_ref(sheet, owning_sheet, sheets)?;
            Ok(Range::new(sheet_id, 0, *start_col, MAX_ROW, *end_col))
        }
        RangeRef::WholeRow {
            sheet,
            start_row,
            end_row,
            ..
        } => {
            let sheet_id = resolve_sheet_ref(sheet, owning_sheet, sheets)?;
            Ok(Range::new(sheet_id, *start_row, 0, *end_row, MAX_COLUMN))
        }
        RangeRef::R1C1Cells { .. } => Err(BindError::UnsupportedVariant(
            "RangeRef::R1C1Cells in reference-aware fn arg is parser-intermediate; \
             storage canon is A1. Should not reach the binder.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_formula_syntax::{CellAddr, RangeRef, SheetRef};

    /// **W5-RT-1 / Step 1.1 (S1-HIGH-C closure):** matcher-only direction
    /// of the `accepts_special_arg_lists_only_registered_reference_aware`
    /// invariant — pin the 7 names the binder treats as reference-aware.
    /// At Step 1 (no fns registered) the registry-side direction is
    /// trivially satisfied (empty loop); Step 2/3/4 add the registry-side
    /// assertions (every name in `reg.lookup_reference_aware` is also in
    /// the matcher).
    ///
    /// The matcher-only direction prevents typo drift in this commit:
    /// future-me adding a name to one place and forgetting the other is
    /// caught at test time, not at user-facing-failure time.
    #[test]
    fn accepts_special_arg_lists_only_registered_reference_aware_matcher_pin() {
        // Every reference-aware name the design v2 enumerates must be
        // recognized by the matcher.
        for name in &[
            "ROW",
            "COLUMN",
            "ROWS",
            "COLUMNS",
            "ISREF",
            "ISFORMULA",
            "FORMULATEXT",
        ] {
            assert!(
                is_reference_aware_function(name),
                "design v2 enumerates {name:?} as reference-aware but matcher \
                 returns false"
            );
        }
        // Sentinel non-reference-aware names (typo guard).
        for name in &[
            "RAW",
            "COLUM",
            "ISFOMULA",
            "FORMULATXT",
            "SUM",
            "IF",
            "VLOOKUP",
        ] {
            assert!(
                !is_reference_aware_function(name),
                "{name:?} is NOT supposed to be reference-aware but matcher \
                 returns true"
            );
        }
    }

    /// **W5-RT-2 (RT-V1-01 Step 2):** registry-side invariant for the 4
    /// fns registered in this step (ROW / COLUMN / ROWS / COLUMNS). ISREF
    /// / ISFORMULA / FORMULATEXT register in Step 3 / 4; this test
    /// extends as those land. Sister to the matcher-pin test above.
    ///
    /// Disjointness: every registered reference-aware name must NOT
    /// also resolve through any other tier — mirrors the
    /// `is_aggregate_function_lists_only_registered_aggregates` pattern
    /// (workbook_runtime.rs:5158).
    ///
    /// **Step 2.1 (S2-MED-γ closure):** also asserts the Step 3/4 names
    /// (ISREF / ISFORMULA / FORMULATEXT) are NOT yet registered — the
    /// matcher pre-lists them so a typo in those names slipping through
    /// Step 2 would otherwise be invisible until Step 3 / 4 ship.
    #[test]
    fn step_2_reference_aware_names_registered_in_reference_tier() {
        use ql_functions::default_registry;
        let reg = default_registry();
        // Registered in Step 2 + Step 3 + Step 4 — all 7 reference-tier
        // fns must be present in all expected places. The mini-phase
        // (RT-V1-01) is now COMPLETE.
        for name in &[
            "ROW",
            "COLUMN",
            "ROWS",
            "COLUMNS",
            "ISREF",
            "ISFORMULA",
            "FORMULATEXT",
        ] {
            assert!(
                reg.lookup_reference_aware(name).is_some(),
                "Step 2 registered {name:?} but lookup_reference_aware can't find it"
            );
            assert!(
                is_reference_aware_function(name),
                "{name:?} is registered as reference-aware but matcher returns false"
            );
            // Disjointness: must not resolve as any other tier.
            assert!(
                reg.lookup(name).is_none(),
                "{name:?} is reference-aware ONLY; must not appear in scalar table"
            );
            assert!(
                reg.lookup_range_aware(name).is_none(),
                "{name:?} is reference-aware ONLY; must not appear in range-aware table"
            );
            assert!(
                reg.lookup_unified(name).is_none(),
                "{name:?} is reference-aware ONLY; must not appear in unified table"
            );
            // **Step 3.1 (S3-MED-γ closure):** also check the
            // context-aware tier — completeness even though HashMap
            // disjointness structurally prevents collision.
            assert!(
                reg.lookup_context_aware(name).is_none(),
                "{name:?} is reference-aware ONLY; must not appear in context-aware table"
            );
        }
        // **Step 4 update (W5-RT-4):** FORMULATEXT now registered.
        // The pending-name sentinel block from Step 2/3 is removed —
        // mini-phase RT-V1-01 is COMPLETE. The loop above covers all 7
        // names with full disjointness across scalar / range-aware /
        // context-aware / unified tiers.
    }

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
            sheet: SheetRef::Current,
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
            sheet: SheetRef::Id(2),
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
                sheet: SheetRef::Current,
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
            sheet: SheetRef::Current,
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

    // ===== W5-90 / Phase 4.6.B — cross-sheet binding via SheetResolver =====

    /// Test-only `SheetResolver`: a fixed `name → id` map.
    struct MockSheetResolver {
        map: std::collections::HashMap<String, SheetId>,
    }
    impl MockSheetResolver {
        fn new(pairs: &[(&str, SheetId)]) -> Self {
            Self {
                map: pairs
                    .iter()
                    .map(|(n, s)| (n.to_ascii_uppercase(), *s))
                    .collect(),
            }
        }
    }
    impl SheetResolver for MockSheetResolver {
        fn resolve_sheet(&self, name: &str) -> Option<SheetId> {
            self.map.get(&name.to_ascii_uppercase()).copied()
        }
    }

    #[test]
    fn bind_resolves_sheet_ref_name_via_resolver() {
        let expr = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from("Sheet2")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        let sheets = MockSheetResolver::new(&[("Sheet2", 1)]);
        let p = bind_with_names_and_sheets(&expr, 0, &EmptyNameLookup, &sheets).expect("bind");
        match p {
            ExprPlan::CellRef { sheet, .. } => assert_eq!(sheet, 1),
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    #[test]
    fn bind_resolves_sheet_ref_name_case_insensitively() {
        let expr = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from("sheet1")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        let sheets = MockSheetResolver::new(&[("Sheet1", 5)]);
        let p = bind_with_names_and_sheets(&expr, 0, &EmptyNameLookup, &sheets).expect("bind");
        match p {
            ExprPlan::CellRef { sheet, .. } => assert_eq!(sheet, 5),
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    #[test]
    fn bind_unknown_sheet_name_surfaces_as_error() {
        let expr = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from("Nonexistent")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        let sheets = MockSheetResolver::new(&[("Sheet1", 0)]);
        let err = bind_with_names_and_sheets(&expr, 0, &EmptyNameLookup, &sheets).unwrap_err();
        match err {
            BindError::UnknownSheet(name) => assert_eq!(name.as_ref(), "Nonexistent"),
            other => panic!("expected UnknownSheet, got {other:?}"),
        }
    }

    #[test]
    fn bind_empty_sheet_resolver_rejects_all_sheet_names() {
        // The legacy `bind()` / `bind_with_names()` entry points use an
        // empty resolver, so any cross-sheet ref errors cleanly.
        let expr = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from("AnySheet")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        let err = bind(&expr, 0).unwrap_err();
        assert!(matches!(err, BindError::UnknownSheet(_)));
    }

    #[test]
    fn bind_current_sheet_resolves_to_owning_sheet() {
        let expr = Expr::CellRef(CellAddr {
            sheet: SheetRef::Current,
            col: 3,
            row: 4,
            abs_col: false,
            abs_row: false,
        });
        let sheets = MockSheetResolver::new(&[]);
        let p = bind_with_names_and_sheets(&expr, 9, &EmptyNameLookup, &sheets).expect("bind");
        match p {
            ExprPlan::CellRef { sheet, .. } => assert_eq!(sheet, 9),
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    #[test]
    fn bind_sheet_resolution_propagates_through_binary_op() {
        // `Sheet2!A1 + 1` — the inner CellRef resolves through the resolver;
        // the binary wraps both bound sides.
        let expr = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(Expr::CellRef(CellAddr {
                sheet: SheetRef::Name(Arc::from("Sheet2")),
                col: 0,
                row: 0,
                abs_col: false,
                abs_row: false,
            })),
            rhs: Box::new(Expr::Number(1.0)),
        };
        let sheets = MockSheetResolver::new(&[("Sheet2", 7)]);
        let p = bind_with_names_and_sheets(&expr, 0, &EmptyNameLookup, &sheets).expect("bind");
        match p {
            ExprPlan::Binary { lhs, .. } => match lhs.as_ref() {
                ExprPlan::CellRef { sheet, .. } => assert_eq!(*sheet, 7),
                other => panic!("expected nested CellRef, got {other:?}"),
            },
            other => panic!("expected Binary, got {other:?}"),
        }
    }

    // ===== W5-99 (Phase 4.7.F) — Expr::Array + Expr::Error lowering =====

    #[test]
    fn bind_error_literal_lowers_to_expr_plan_error() {
        let expr = Expr::Error(ErrorValue::Ref);
        let p = bind(&expr, 0).expect("bind");
        match p {
            ExprPlan::Error(ev) => assert_eq!(ev, ErrorValue::Ref),
            other => panic!("expected ExprPlan::Error, got {other:?}"),
        }
    }

    #[test]
    fn bind_array_literal_lowers_element_wise() {
        // `{1, "hi"; TRUE, #N/A}` — 2x2 with all four allowed cell kinds.
        let expr = Expr::Array(vec![
            vec![Expr::Number(1.0), Expr::String(Arc::from("hi"))],
            vec![Expr::Bool(true), Expr::Error(ErrorValue::NA)],
        ]);
        let p = bind(&expr, 0).expect("bind");
        match p {
            ExprPlan::Array(rows) => {
                assert_eq!(rows.len(), 2);
                assert_eq!(rows[0].len(), 2);
                assert!(matches!(rows[0][0], ExprPlan::Number(n) if n == 1.0));
                match &rows[0][1] {
                    ExprPlan::String(s) => assert_eq!(s.as_ref(), "hi"),
                    other => panic!("expected String, got {other:?}"),
                }
                assert!(matches!(rows[1][0], ExprPlan::Bool(true)));
                assert!(matches!(rows[1][1], ExprPlan::Error(ErrorValue::NA)));
            }
            other => panic!("expected ExprPlan::Array, got {other:?}"),
        }
    }

    #[test]
    fn bind_array_literal_rejects_ragged_via_arity_error() {
        // Direct-AST construction of a ragged array. The PARSER would
        // reject this via `ParseError::ArrayRowArityMismatch`, but the
        // binder is defense in depth — `Expr::Array` is a public
        // variant.
        let expr = Expr::Array(vec![
            vec![Expr::Number(1.0), Expr::Number(2.0)],
            vec![Expr::Number(3.0)],
        ]);
        let err = bind(&expr, 0).unwrap_err();
        match err {
            BindError::ArrayRowArityMismatch {
                expected,
                found,
                row,
            } => {
                assert_eq!(expected, 2);
                assert_eq!(found, 1);
                assert_eq!(row, 1);
            }
            other => panic!("expected ArrayRowArityMismatch, got {other:?}"),
        }
    }

    #[test]
    fn bind_array_literal_rejects_non_literal_cell() {
        // Array cell containing a CellRef — parser wouldn't emit this,
        // but defense in depth covers direct AST construction.
        let expr = Expr::Array(vec![vec![
            Expr::Number(1.0),
            Expr::CellRef(CellAddr {
                sheet: SheetRef::Current,
                col: 0,
                row: 0,
                abs_col: false,
                abs_row: false,
            }),
        ]]);
        let err = bind(&expr, 0).unwrap_err();
        match err {
            BindError::ArrayCellNotLiteral { row, col, got } => {
                assert_eq!(row, 0);
                assert_eq!(col, 1);
                assert_eq!(got, "CellRef");
            }
            other => panic!("expected ArrayCellNotLiteral, got {other:?}"),
        }
    }

    #[test]
    fn bind_array_literal_rejects_nested_array() {
        // Nested array — `Expr::Array` inside an array cell. Parser
        // rejects this with InvalidArrayCellToken; binder rejects with
        // ArrayCellNotLiteral.
        let expr = Expr::Array(vec![vec![
            Expr::Number(1.0),
            Expr::Array(vec![vec![Expr::Number(2.0)]]),
        ]]);
        let err = bind(&expr, 0).unwrap_err();
        match err {
            BindError::ArrayCellNotLiteral { got, .. } => assert_eq!(got, "Array"),
            other => panic!("expected ArrayCellNotLiteral, got {other:?}"),
        }
    }

    #[test]
    fn bind_array_literal_zero_rows_rejects() {
        // W5-99 closure (Codex MEDIUM-7): now uses the dedicated
        // EmptyArrayLiteral variant (was UnsupportedVariant pre-closure).
        let expr = Expr::Array(vec![]);
        let err = bind(&expr, 0).unwrap_err();
        assert!(matches!(err, BindError::EmptyArrayLiteral));
    }

    #[test]
    fn bind_array_literal_one_empty_row_rejects() {
        // W5-99 closure (Codex MEDIUM-7): the degenerate case Codex caught
        // — `Expr::Array(vec![vec![]])` (one row, zero cells) was
        // previously accepted because `expected_arity = rows[0].len() = 0`
        // matched every subsequent row. Now rejected.
        let expr = Expr::Array(vec![vec![]]);
        let err = bind(&expr, 0).unwrap_err();
        assert!(matches!(err, BindError::EmptyArrayLiteral));
    }

    #[test]
    fn bind_array_literal_rejects_name_ref_cell() {
        // W5-99 closure (Sonnet M-1): NameRef as array-cell — parser
        // rejects via InvalidArrayCellToken; binder mirror for
        // direct-AST construction.
        let expr = Expr::Array(vec![vec![
            Expr::Number(1.0),
            Expr::NameRef(Arc::from("TAXRATE")),
        ]]);
        let err = bind(&expr, 0).unwrap_err();
        match err {
            BindError::ArrayCellNotLiteral { row, col, got } => {
                assert_eq!(row, 0);
                assert_eq!(col, 1);
                assert_eq!(got, "NameRef");
            }
            other => panic!("expected ArrayCellNotLiteral, got {other:?}"),
        }
    }

    #[test]
    fn bind_array_literal_rejects_function_cell() {
        // W5-99 closure (Sonnet M-1): Function call as array-cell.
        let expr = Expr::Array(vec![vec![
            Expr::Number(1.0),
            Expr::Function {
                name: Arc::from("SUM"),
                args: vec![Expr::Number(1.0)],
            },
        ]]);
        let err = bind(&expr, 0).unwrap_err();
        match err {
            BindError::ArrayCellNotLiteral { row, col, got } => {
                assert_eq!(row, 0);
                assert_eq!(col, 1);
                assert_eq!(got, "Function");
            }
            other => panic!("expected ArrayCellNotLiteral, got {other:?}"),
        }
    }

    #[test]
    fn bind_array_literal_singleton_lowers() {
        // 1x1 array — degenerate but valid.
        let expr = Expr::Array(vec![vec![Expr::Number(42.0)]]);
        let p = bind(&expr, 0).expect("bind");
        match p {
            ExprPlan::Array(rows) => {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].len(), 1);
                assert!(matches!(rows[0][0], ExprPlan::Number(n) if n == 42.0));
            }
            other => panic!("expected ExprPlan::Array, got {other:?}"),
        }
    }

    #[test]
    fn bind_array_literal_3x2_lowers() {
        // 3x2 — exercises the arity-check loop past the second row.
        let expr = Expr::Array(vec![
            vec![Expr::Number(1.0), Expr::Number(2.0)],
            vec![Expr::Number(3.0), Expr::Number(4.0)],
            vec![Expr::Number(5.0), Expr::Number(6.0)],
        ]);
        let p = bind(&expr, 0).expect("bind");
        match p {
            ExprPlan::Array(rows) => {
                assert_eq!(rows.len(), 3);
                for row in &rows {
                    assert_eq!(row.len(), 2);
                }
            }
            other => panic!("expected ExprPlan::Array, got {other:?}"),
        }
    }

    // ===== W5-115 (Phase 4.8.F) — structured-ref binder resolution =====

    use ql_formula_syntax::{SpecialItem, TableSpecItem, TableSpecSubtree};
    use ql_storage::{TableColumn, TableMetadata};

    /// Mock TableLookup that holds a single test table.
    struct OneTable(TableMetadata);
    impl TableLookup for OneTable {
        fn lookup_table(&self, name: &str) -> Option<&TableMetadata> {
            if name.eq_ignore_ascii_case(&self.0.name) {
                Some(&self.0)
            } else {
                None
            }
        }
    }

    fn sales_table() -> TableMetadata {
        // Sales table at sheet 0, A1:D10. Header at row 0, totals at row 9.
        // Data rows: 1..8 (8 rows). Columns: Region, Product, Qty, Price.
        let col = |id, name: &str| TableColumn {
            id,
            name: Arc::from(name.to_ascii_lowercase().as_str()),
            display: Arc::from(name),
            totals_function: None,
        };
        TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 10,
            cols: 4,
            has_header: true,
            has_totals: true,
            columns: vec![
                col(0, "Region"),
                col(1, "Product"),
                col(2, "Qty"),
                col(3, "Price"),
            ],
        }
    }

    #[test]
    fn bind_structured_ref_bare_column_resolves_to_data_range() {
        let tables = OneTable(sales_table());
        let expr = Expr::StructuredRef {
            table_name: Arc::from("Sales"),
            spec: TableSpecSubtree::BareColumn(Arc::from("Qty")),
        };
        let plan = bind_with_site(
            &expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap();
        match plan {
            ExprPlan::StructuredRef {
                table_name,
                resolved,
                is_this_row,
                ..
            } => {
                assert_eq!(table_name.as_ref(), "SALES");
                // Qty is column 2; data rows = 1..8.
                assert_eq!(resolved.start_row, 1);
                assert_eq!(resolved.end_row, 8);
                assert_eq!(resolved.start_col, 2);
                assert_eq!(resolved.end_col, 2);
                assert!(!is_this_row);
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn bind_structured_ref_unknown_table_errors() {
        let tables = EmptyTableLookup;
        let expr = Expr::StructuredRef {
            table_name: Arc::from("Sales"),
            spec: TableSpecSubtree::BareColumn(Arc::from("Qty")),
        };
        let err = bind_with_site(
            &expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap_err();
        match err {
            BindError::UnknownTable(name) => assert_eq!(name.as_ref(), "Sales"),
            other => panic!("expected UnknownTable, got {other:?}"),
        }
    }

    #[test]
    fn bind_structured_ref_unknown_column_errors() {
        let tables = OneTable(sales_table());
        let expr = Expr::StructuredRef {
            table_name: Arc::from("Sales"),
            spec: TableSpecSubtree::BareColumn(Arc::from("Foobar")),
        };
        let err = bind_with_site(
            &expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap_err();
        match err {
            BindError::UnknownTableColumn { table, column } => {
                assert_eq!(table.as_ref(), "SALES");
                assert_eq!(column.as_ref(), "Foobar");
            }
            other => panic!("expected UnknownTableColumn, got {other:?}"),
        }
    }

    #[test]
    fn bind_structured_ref_headers_resolves_to_header_row() {
        let tables = OneTable(sales_table());
        let expr = Expr::StructuredRef {
            table_name: Arc::from("Sales"),
            spec: TableSpecSubtree::Combination(vec![TableSpecItem::Special(SpecialItem::Headers)]),
        };
        let plan = bind_with_site(
            &expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap();
        match plan {
            ExprPlan::StructuredRef { resolved, .. } => {
                // Header row = row 0, cols 0..3.
                assert_eq!(resolved.start_row, 0);
                assert_eq!(resolved.end_row, 0);
                assert_eq!(resolved.start_col, 0);
                assert_eq!(resolved.end_col, 3);
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn bind_structured_ref_special_column_intersection() {
        // `Sales[[#Headers], [Qty]]` → header cell of Qty column (row 0, col 2).
        let tables = OneTable(sales_table());
        let expr = Expr::StructuredRef {
            table_name: Arc::from("Sales"),
            spec: TableSpecSubtree::Combination(vec![
                TableSpecItem::Special(SpecialItem::Headers),
                TableSpecItem::Column(Arc::from("Qty")),
            ]),
        };
        let plan = bind_with_site(
            &expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap();
        match plan {
            ExprPlan::StructuredRef { resolved, .. } => {
                assert_eq!(resolved.start_row, 0);
                assert_eq!(resolved.end_row, 0);
                assert_eq!(resolved.start_col, 2);
                assert_eq!(resolved.end_col, 2);
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn bind_structured_ref_column_range() {
        // `Sales[[Qty]:[Price]]` → cols 2..3 over data rows 1..8.
        let tables = OneTable(sales_table());
        let expr = Expr::StructuredRef {
            table_name: Arc::from("Sales"),
            spec: TableSpecSubtree::Combination(vec![TableSpecItem::ColumnRange(
                Arc::from("Qty"),
                Arc::from("Price"),
            )]),
        };
        let plan = bind_with_site(
            &expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap();
        match plan {
            ExprPlan::StructuredRef { resolved, .. } => {
                assert_eq!(resolved.start_row, 1);
                assert_eq!(resolved.end_row, 8);
                assert_eq!(resolved.start_col, 2);
                assert_eq!(resolved.end_col, 3);
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn bind_structured_ref_all_resolves_to_full_footprint() {
        let tables = OneTable(sales_table());
        let expr = Expr::StructuredRef {
            table_name: Arc::from("Sales"),
            spec: TableSpecSubtree::Combination(vec![TableSpecItem::Special(SpecialItem::All)]),
        };
        let plan = bind_with_site(
            &expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap();
        match plan {
            ExprPlan::StructuredRef { resolved, .. } => {
                assert_eq!(resolved.start_row, 0);
                assert_eq!(resolved.end_row, 9);
                assert_eq!(resolved.start_col, 0);
                assert_eq!(resolved.end_col, 3);
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn bind_structured_ref_this_row_column_sets_flag() {
        let tables = OneTable(sales_table());
        let expr = Expr::StructuredRef {
            table_name: Arc::from("Sales"),
            spec: TableSpecSubtree::ThisRowColumn(Arc::from("Qty")),
        };
        let plan = bind_with_site(
            &expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap();
        match plan {
            ExprPlan::StructuredRef {
                resolved,
                is_this_row,
                ..
            } => {
                assert!(is_this_row, "ThisRowColumn must set is_this_row");
                // Resolved is FULL column data range; eval narrows at runtime.
                assert_eq!(resolved.start_row, 1);
                assert_eq!(resolved.end_row, 8);
                assert_eq!(resolved.start_col, 2);
                assert_eq!(resolved.end_col, 2);
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn bind_structured_ref_headers_on_table_without_header_errors() {
        let mut t = sales_table();
        t.has_header = false;
        let tables = OneTable(t);
        let expr = Expr::StructuredRef {
            table_name: Arc::from("Sales"),
            spec: TableSpecSubtree::Combination(vec![TableSpecItem::Special(SpecialItem::Headers)]),
        };
        let err = bind_with_site(
            &expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap_err();
        match err {
            BindError::TableHasNoHeader(name) => assert_eq!(name.as_ref(), "SALES"),
            other => panic!("expected TableHasNoHeader, got {other:?}"),
        }
    }

    // ===================================================================
    // W5-140 (Phase 4.9.C binder) — R1C1 lowering to absolute CellRef.
    // ===================================================================

    use ql_types::Address;

    fn r1c1_expr(row: AxisSpec, col: AxisSpec) -> Expr {
        Expr::R1C1Ref {
            sheet: SheetRef::Current,
            row_axis: row,
            col_axis: col,
        }
    }

    fn bind_r1c1_at(expr: &Expr, anchor: Address) -> Result<ExprPlan, BindError> {
        bind_with_site(
            expr,
            BindSite::at_cell(anchor),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &EmptyTableLookup,
        )
    }

    fn bind_r1c1_no_anchor(expr: &Expr) -> Result<ExprPlan, BindError> {
        bind_with_site(
            expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &EmptyTableLookup,
        )
    }

    /// **Absolute axes lower with the anchor's sheet.** `R3C5` →
    /// `CellRef { row: 2, col: 4, abs_row: true, abs_col: true }`.
    #[test]
    fn r1c1_bind_absolute_lowers_to_cellref() {
        let expr = r1c1_expr(AxisSpec::Abs(3), AxisSpec::Abs(5));
        let p = bind_r1c1_at(
            &expr,
            Address {
                sheet: 0,
                row: 0,
                col: 0,
            },
        )
        .unwrap();
        match p {
            ExprPlan::CellRef {
                sheet,
                row,
                col,
                abs_col,
                abs_row,
            } => {
                assert_eq!(sheet, 0);
                assert_eq!(row, 2);
                assert_eq!(col, 4);
                assert!(abs_row);
                assert!(abs_col);
            }
            other => panic!("expected ExprPlan::CellRef, got {other:?}"),
        }
    }

    /// **Relative axes lower against the anchor.** Anchor at (5, 5),
    /// `R[-1]C[2]` → `CellRef { row: 4, col: 7, abs_row: false,
    /// abs_col: false }`.
    #[test]
    fn r1c1_bind_relative_lowers_against_anchor() {
        let expr = r1c1_expr(AxisSpec::Rel(-1), AxisSpec::Rel(2));
        let p = bind_r1c1_at(
            &expr,
            Address {
                sheet: 0,
                row: 5,
                col: 5,
            },
        )
        .unwrap();
        match p {
            ExprPlan::CellRef {
                row,
                col,
                abs_col,
                abs_row,
                ..
            } => {
                assert_eq!(row, 4);
                assert_eq!(col, 7);
                assert!(!abs_row);
                assert!(!abs_col);
            }
            other => panic!("expected ExprPlan::CellRef, got {other:?}"),
        }
    }

    /// **Bare `RC` (Rel(0)) on both axes resolves to the anchor cell.**
    #[test]
    fn r1c1_bind_bare_rc_resolves_to_anchor() {
        let expr = r1c1_expr(AxisSpec::Rel(0), AxisSpec::Rel(0));
        let p = bind_r1c1_at(
            &expr,
            Address {
                sheet: 0,
                row: 10,
                col: 7,
            },
        )
        .unwrap();
        match p {
            ExprPlan::CellRef { row, col, .. } => {
                assert_eq!(row, 10);
                assert_eq!(col, 7);
            }
            other => panic!("expected ExprPlan::CellRef, got {other:?}"),
        }
    }

    /// **Mixed axes lower correctly with per-axis abs flags.** `R1C[2]`
    /// at anchor (5, 5) → CellRef { row: 0, col: 7, abs_row: true,
    /// abs_col: false }.
    #[test]
    fn r1c1_bind_mixed_abs_row_rel_col_per_axis_flags() {
        let expr = r1c1_expr(AxisSpec::Abs(1), AxisSpec::Rel(2));
        let p = bind_r1c1_at(
            &expr,
            Address {
                sheet: 0,
                row: 5,
                col: 5,
            },
        )
        .unwrap();
        match p {
            ExprPlan::CellRef {
                row,
                col,
                abs_row,
                abs_col,
                ..
            } => {
                assert_eq!(row, 0);
                assert_eq!(col, 7);
                assert!(abs_row);
                assert!(!abs_col);
            }
            other => panic!("expected ExprPlan::CellRef, got {other:?}"),
        }
    }

    /// **Relative axis without anchor fails loudly.** Bind site has
    /// `cell: None` → `R1C1RequiresAnchor`. Closes design § 3.1
    /// "bind-time resolution requires anchor."
    #[test]
    fn r1c1_bind_relative_without_anchor_rejected() {
        let expr = r1c1_expr(AxisSpec::Rel(0), AxisSpec::Rel(0));
        let err = bind_r1c1_no_anchor(&expr).unwrap_err();
        assert!(matches!(err, BindError::R1C1RequiresAnchor));
    }

    /// **All-absolute R1C1 binds even without an anchor.** No anchor
    /// is required when both axes are absolute.
    #[test]
    fn r1c1_bind_absolute_no_anchor_still_works() {
        let expr = r1c1_expr(AxisSpec::Abs(1), AxisSpec::Abs(1));
        let p = bind_r1c1_no_anchor(&expr).unwrap();
        match p {
            ExprPlan::CellRef { row, col, .. } => {
                assert_eq!(row, 0);
                assert_eq!(col, 0);
            }
            other => panic!("expected ExprPlan::CellRef, got {other:?}"),
        }
    }

    /// **Relative offset that underflows the grid → R1C1OutOfBounds.**
    /// Anchor at (0, 0), `R[-1]C` → resolved row would be -1.
    #[test]
    fn r1c1_bind_relative_underflow_rejected() {
        let expr = r1c1_expr(AxisSpec::Rel(-1), AxisSpec::Rel(0));
        let err = bind_r1c1_at(
            &expr,
            Address {
                sheet: 0,
                row: 0,
                col: 0,
            },
        )
        .unwrap_err();
        match err {
            BindError::R1C1OutOfBounds { resolved_row, .. } => {
                assert_eq!(resolved_row, Some(-1));
            }
            other => panic!("expected R1C1OutOfBounds, got {other:?}"),
        }
    }

    /// **Relative offset that overflows the grid → R1C1OutOfBounds.**
    /// Anchor at MAX_ROW, `R[1]C` → resolved row exceeds MAX_ROW.
    #[test]
    fn r1c1_bind_relative_overflow_rejected() {
        let expr = r1c1_expr(AxisSpec::Rel(1), AxisSpec::Rel(0));
        let err = bind_r1c1_at(
            &expr,
            Address {
                sheet: 0,
                row: MAX_ROW,
                col: 0,
            },
        )
        .unwrap_err();
        match err {
            BindError::R1C1OutOfBounds { resolved_row, .. } => {
                assert_eq!(resolved_row, Some(MAX_ROW as i64 + 1));
            }
            other => panic!("expected R1C1OutOfBounds, got {other:?}"),
        }
    }

    /// **Sheet ref resolved at bind time.** `Sheet1!R1C1` with the
    /// SheetResolver mapping `Sheet1 → 7` lowers to
    /// `CellRef { sheet: 7, .. }`.
    #[test]
    fn r1c1_bind_sheet_qualified_resolves_sheet_id() {
        struct OneSheet;
        impl SheetResolver for OneSheet {
            fn resolve_sheet(&self, name: &str) -> Option<SheetId> {
                if name.eq_ignore_ascii_case("Sheet1") {
                    Some(7)
                } else {
                    None
                }
            }
        }
        let expr = Expr::R1C1Ref {
            sheet: SheetRef::Name(Arc::from("Sheet1")),
            row_axis: AxisSpec::Abs(3),
            col_axis: AxisSpec::Abs(5),
        };
        let p = bind_with_site(
            &expr,
            BindSite::at_cell(Address {
                sheet: 0,
                row: 0,
                col: 0,
            }),
            &EmptyNameLookup,
            &OneSheet,
            &EmptyTableLookup,
        )
        .unwrap();
        match p {
            ExprPlan::CellRef { sheet, .. } => assert_eq!(sheet, 7),
            other => panic!("expected ExprPlan::CellRef, got {other:?}"),
        }
    }

    /// **Unknown sheet on R1C1 ref surfaces UnknownSheet.** Mirrors
    /// the existing CellRef-side behavior.
    #[test]
    fn r1c1_bind_unknown_sheet_errors() {
        let expr = Expr::R1C1Ref {
            sheet: SheetRef::Name(Arc::from("Missing")),
            row_axis: AxisSpec::Abs(1),
            col_axis: AxisSpec::Abs(1),
        };
        let err = bind_r1c1_no_anchor(&expr).unwrap_err();
        match err {
            BindError::UnknownSheet(n) => assert_eq!(n.as_ref(), "Missing"),
            other => panic!("expected UnknownSheet, got {other:?}"),
        }
    }

    /// **Absolute axis at the grid boundary lowers OK.** `R1048576C16384`
    /// = (MAX_ROW + 1, MAX_COLUMN + 1) in source 1-indexed form →
    /// row MAX_ROW, col MAX_COLUMN in 0-indexed bound form.
    #[test]
    fn r1c1_bind_absolute_at_grid_boundary() {
        let expr = r1c1_expr(AxisSpec::Abs(MAX_ROW + 1), AxisSpec::Abs(MAX_COLUMN + 1));
        let p = bind_r1c1_no_anchor(&expr).unwrap();
        match p {
            ExprPlan::CellRef { row, col, .. } => {
                assert_eq!(row, MAX_ROW);
                assert_eq!(col, MAX_COLUMN);
            }
            other => panic!("expected ExprPlan::CellRef, got {other:?}"),
        }
    }

    /// **Absolute axis exceeding grid bound → R1C1OutOfBounds.**
    /// Defense-in-depth — lexer already rejects this via
    /// `RowTooLarge`, but the binder is the second line of defense
    /// (direct AST construction can bypass the lexer).
    #[test]
    fn r1c1_bind_absolute_overflow_rejected() {
        let expr = r1c1_expr(AxisSpec::Abs(MAX_ROW + 2), AxisSpec::Abs(1));
        let err = bind_r1c1_no_anchor(&expr).unwrap_err();
        assert!(matches!(err, BindError::R1C1OutOfBounds { .. }));
    }

    /// **Variant_kind reports "R1C1Ref" for R1C1 forms.** Used by
    /// the array-cell rejection diagnostic.
    #[test]
    fn r1c1_variant_kind_string() {
        let expr = r1c1_expr(AxisSpec::Abs(1), AxisSpec::Abs(1));
        assert_eq!(variant_kind(&expr), "R1C1Ref");
    }

    // ===================================================================
    // W5-144 (Phase 4.9.H) — `@` (implicit intersection) bind tests.
    // ===================================================================

    use ql_formula_syntax::{lex, parse};

    fn bind_at(src: &str, anchor: Address) -> Result<ExprPlan, BindError> {
        let tokens = lex(src).expect("lex");
        let expr = parse(tokens).expect("parse");
        bind_with_site(
            &expr,
            BindSite::at_cell(anchor),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &EmptyTableLookup,
        )
    }

    /// **Rule 1: scalar inner passes through.** `@5` binds to
    /// `ExprPlan::Number(5)`. The wrapper is dropped at bind time.
    #[test]
    fn at_scalar_number_drops_wrapper() {
        let p = bind_at(
            "@5",
            Address {
                sheet: 0,
                row: 0,
                col: 0,
            },
        )
        .unwrap();
        assert_eq!(p, ExprPlan::Number(5.0));
    }

    /// **Rule 1: boolean inner passes through.**
    #[test]
    fn at_scalar_bool_drops_wrapper() {
        let p = bind_at(
            "@TRUE",
            Address {
                sheet: 0,
                row: 0,
                col: 0,
            },
        )
        .unwrap();
        assert_eq!(p, ExprPlan::Bool(true));
    }

    /// **Rule 5: single CellRef passes through (idempotent).**
    #[test]
    fn at_cellref_idempotent() {
        let p = bind_at(
            "@A1",
            Address {
                sheet: 0,
                row: 0,
                col: 0,
            },
        )
        .unwrap();
        match p {
            ExprPlan::CellRef { row, col, .. } => {
                assert_eq!(row, 0);
                assert_eq!(col, 0);
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    /// **Rule 2: bounded range, single column, formula row in span.**
    /// `@A1:A10` at anchor (B5) → A5.
    #[test]
    fn at_single_column_narrows_to_anchor_row() {
        let p = bind_at(
            "@A1:A10",
            Address {
                sheet: 0,
                row: 4,
                col: 1,
            },
        )
        .unwrap();
        match p {
            ExprPlan::CellRef { row, col, .. } => {
                assert_eq!(row, 4); // anchor row
                assert_eq!(col, 0); // column A
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    /// **Rule 2: out of row span → #VALUE!.** `@A1:A10` at row 100.
    #[test]
    fn at_single_column_out_of_row_span_returns_value_error() {
        let p = bind_at(
            "@A1:A10",
            Address {
                sheet: 0,
                row: 99,
                col: 5,
            },
        )
        .unwrap();
        assert_eq!(p, ExprPlan::Error(ErrorValue::Value));
    }

    /// **Rule 3: bounded range, single row, formula col in span.**
    /// `@A1:E1` at anchor (C5) → C1.
    #[test]
    fn at_single_row_narrows_to_anchor_col() {
        let p = bind_at(
            "@A1:E1",
            Address {
                sheet: 0,
                row: 4,
                col: 2,
            },
        )
        .unwrap();
        match p {
            ExprPlan::CellRef { row, col, .. } => {
                assert_eq!(row, 0); // range row
                assert_eq!(col, 2); // anchor col
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    /// **Rule 3: out of col span → #VALUE!.**
    #[test]
    fn at_single_row_out_of_col_span_returns_value_error() {
        let p = bind_at(
            "@A1:E1",
            Address {
                sheet: 0,
                row: 4,
                col: 100,
            },
        )
        .unwrap();
        assert_eq!(p, ExprPlan::Error(ErrorValue::Value));
    }

    /// **Rule 4: 2-D range → ALWAYS #VALUE! regardless of anchor.**
    #[test]
    fn at_two_d_range_always_returns_value_error() {
        let p = bind_at(
            "@A1:E10",
            Address {
                sheet: 0,
                row: 4,
                col: 2,
            },
        )
        .unwrap();
        assert_eq!(p, ExprPlan::Error(ErrorValue::Value));
    }

    /// **Rule 5: single-cell range `A1:A1` → single cell.**
    #[test]
    fn at_single_cell_range_returns_single_cell() {
        let p = bind_at(
            "@A1:A1",
            Address {
                sheet: 0,
                row: 5,
                col: 5,
            },
        )
        .unwrap();
        match p {
            ExprPlan::CellRef { row, col, .. } => {
                assert_eq!(row, 0);
                assert_eq!(col, 0);
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    /// **Rule 6: WholeColumn `A:A` narrows to anchor row.**
    #[test]
    fn at_whole_column_narrows_to_anchor_row() {
        let p = bind_at(
            "@A:A",
            Address {
                sheet: 0,
                row: 4,
                col: 1,
            },
        )
        .unwrap();
        match p {
            ExprPlan::CellRef { row, col, .. } => {
                assert_eq!(row, 4);
                assert_eq!(col, 0);
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    /// **Rule 6: WholeRow `1:1` narrows to anchor col.**
    #[test]
    fn at_whole_row_narrows_to_anchor_col() {
        let p = bind_at(
            "@1:1",
            Address {
                sheet: 0,
                row: 4,
                col: 1,
            },
        )
        .unwrap();
        match p {
            ExprPlan::CellRef { row, col, .. } => {
                assert_eq!(row, 0);
                assert_eq!(col, 1);
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    /// **Rule 6: multi-column whole-column `A:B` → #VALUE! (2-D).**
    #[test]
    fn at_multi_whole_column_returns_value_error() {
        let p = bind_at(
            "@A:B",
            Address {
                sheet: 0,
                row: 4,
                col: 1,
            },
        )
        .unwrap();
        assert_eq!(p, ExprPlan::Error(ErrorValue::Value));
    }

    /// **Rule 7: array literal → top-left.** `@{1, 2, 3}` → 1.
    #[test]
    fn at_array_literal_returns_top_left() {
        let p = bind_at(
            "@{1, 2, 3}",
            Address {
                sheet: 0,
                row: 0,
                col: 0,
            },
        )
        .unwrap();
        assert_eq!(p, ExprPlan::Number(1.0));
    }

    /// **Rule 8: function inner — wrapper drops, function binds
    /// normally.** `@SUM(A1)` binds to `Function(SUM, [CellRef(A1)])`.
    #[test]
    fn at_function_inner_drops_wrapper() {
        let p = bind_at(
            "@SUM(A1)",
            Address {
                sheet: 0,
                row: 0,
                col: 0,
            },
        )
        .unwrap();
        match p {
            ExprPlan::Function { name, args } => {
                assert_eq!(name.as_ref(), "SUM");
                assert_eq!(args.len(), 1);
            }
            other => panic!("expected Function, got {other:?}"),
        }
    }

    /// **Nested `@@5` is idempotent.** `@@5` collapses to
    /// `ExprPlan::Number(5)`.
    #[test]
    fn nested_at_collapses() {
        let p = bind_at(
            "@@5",
            Address {
                sheet: 0,
                row: 0,
                col: 0,
            },
        )
        .unwrap();
        assert_eq!(p, ExprPlan::Number(5.0));
    }

    /// **`@<range>` without anchor → `ImplicitIntersectionRequiresAnchor`.**
    #[test]
    fn at_range_without_anchor_errors() {
        let tokens = lex("@A1:A10").unwrap();
        let expr = parse(tokens).unwrap();
        let err = bind_with_site(
            &expr,
            BindSite::sheet_only(0),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &EmptyTableLookup,
        )
        .unwrap_err();
        assert!(matches!(err, BindError::ImplicitIntersectionRequiresAnchor));
    }

    /// **W5-151 (4.9.O MEDIUM-1 closure):** `@<column-ref>` sets
    /// `is_this_row: true` on the bound StructuredRef. This is the
    /// load-bearing case for `=@Sales[Qty]` ≡ `Sales[@Qty]`.
    #[test]
    fn at_bare_column_structured_ref_sets_is_this_row_true() {
        let tables = OneTable(sales_table());
        let tokens = lex("@Sales[Qty]").unwrap();
        let expr = parse(tokens).unwrap();
        let plan = bind_with_site(
            &expr,
            BindSite::at_cell(Address {
                sheet: 0,
                row: 1,
                col: 0,
            }),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap();
        match plan {
            ExprPlan::StructuredRef { is_this_row, .. } => {
                assert!(is_this_row, "@<BareColumn> must set is_this_row=true");
            }
            other => panic!("expected ExprPlan::StructuredRef, got {other:?}"),
        }
    }

    /// **W5-151 (4.9.O MEDIUM-1 closure):** `@<#Headers, BareCol>`
    /// combination — `@Sales[[#Headers], [Qty]]` resolves to a single
    /// header cell. Pre-fix, the binder force-overrode
    /// `is_this_row: true`, making eval try to narrow the header cell
    /// to the formula's row (returns `#VALUE!` for any formula not in
    /// the header row). Post-fix, the @ patch is a NO-OP for non-bare-
    /// column specs: `is_this_row` stays at whatever
    /// `resolve_structured_ref` returned (false for `[#Headers]` →
    /// single header cell is idempotent, rule 5).
    #[test]
    fn at_headers_combination_does_not_force_is_this_row() {
        let tables = OneTable(sales_table());
        let tokens = lex("@Sales[[#Headers],[Qty]]").unwrap();
        let expr = parse(tokens).unwrap();
        let plan = bind_with_site(
            &expr,
            BindSite::at_cell(Address {
                sheet: 0,
                row: 99,
                col: 0,
            }),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap();
        match plan {
            ExprPlan::StructuredRef { is_this_row, .. } => {
                assert!(
                    !is_this_row,
                    "@<Headers combination> must preserve is_this_row=false from resolve"
                );
            }
            other => panic!("expected ExprPlan::StructuredRef, got {other:?}"),
        }
    }

    /// **W5-151 (4.9.O MEDIUM-1 closure):** `@<#All>` resolves to
    /// the full 2-D footprint. The @ patch should NOT force
    /// `is_this_row: true` — design rule 4 says 2-D ranges under @
    /// are always `#VALUE!`. The `is_this_row` flag is irrelevant
    /// for 2-D ranges; preserving `resolve`'s false is correct.
    #[test]
    fn at_all_combination_does_not_force_is_this_row() {
        let tables = OneTable(sales_table());
        let tokens = lex("@Sales[[#All]]").unwrap();
        let expr = parse(tokens).unwrap();
        let plan = bind_with_site(
            &expr,
            BindSite::at_cell(Address {
                sheet: 0,
                row: 1,
                col: 0,
            }),
            &EmptyNameLookup,
            &EmptySheetResolver,
            &tables,
        )
        .unwrap();
        match plan {
            ExprPlan::StructuredRef { is_this_row, .. } => {
                assert!(
                    !is_this_row,
                    "@<#All combination> must preserve is_this_row=false from resolve"
                );
            }
            other => panic!("expected ExprPlan::StructuredRef, got {other:?}"),
        }
    }
}
