//! Reference-aware function dispatch tier (RT-V1 / W5-RT-1).
//!
//! Fifth function-table tier alongside `Scalar`, `RangeAware`, `ContextAware`, and `Unified`.
//! Introduced to support functions whose semantics depend on the **syntactic shape** of an
//! argument expression (ISREF) or on **storage metadata** of the referenced cell (ISFORMULA,
//! FORMULATEXT), in addition to the usual address-aware functions (ROW, COLUMN, ROWS, COLUMNS).
//!
//! Design doc: `docs/architecture/2026-05-17-reference-tier-design.md` v2.
//! Pre-review reconciliation: `docs/audits/2026-05-17-reference-tier-pre-review-summary.md`.
//!
//! ## Why a fifth tier
//!
//! The four existing tiers all hand a function **pre-evaluated `Value`s**. Address information
//! (sheet, row, col) is lost at the dispatcher boundary — `env.read_cell(sheet, row, col)`
//! returns a `Value` and that's all the called function sees. Reference-aware functions need
//! at least one of:
//!
//! 1. The arg's **resolved address or range**, separate from its dereferenced value (ROW,
//!    COLUMN, ROWS, COLUMNS).
//! 2. The **workbook's storage metadata** about whether a cell holds a formula and what the
//!    formula text is (ISFORMULA, FORMULATEXT).
//! 3. The **syntactic shape** of the arg expression without evaluating it (ISREF — must
//!    return FALSE for `ISREF(1/0)` without surfacing `#DIV/0!`).
//!
//! Codex+Opus parallel pre-review (2026-05-17) closed 8 HIGH+ findings around v1's design,
//! including:
//! - The new plan variant `ExprPlan::RangeRef { range }` (HIGH-A) for literal-range args.
//! - The eager-vs-lazy materializer split (HIGH-B) for ISREF.
//! - `RefArg::Array` (HIGH-C) for `ROWS({1,2,3;4,5,6})`.
//! - `RefArg::Error` (HIGH-F) to preserve `#REF!` propagation.
//! - Dep-suppress walker policy (HIGH-H) for ROW/COLUMN/ROWS/COLUMNS/ISREF.

use ql_types::{Address, ArrayValue, ColId, ErrorValue, EvalContext, Range, RowId, SheetId, Value};

/// Argument to a reference-aware function. Materialized by the dispatcher per the fn's
/// [`ArgContract`] (eager vs lazy-shape).
#[derive(Clone, Debug, PartialEq)]
pub enum RefArg {
    /// A pre-evaluated literal (non-reference, non-error). Producers: arithmetic exprs,
    /// function calls, string/number/bool literals.
    Scalar(Value),
    /// A range argument carrying a resolved [`Range`] directly. **In v1 `values` is always
    /// empty** — the dispatcher's `materialize_ref_arg_eager` skips `read_range_with_shape`
    /// for all reference-tier consumers (ROWS/COLUMNS coordinate-only path), so the only
    /// produced shape is `Range { range, values: vec![] }`. The field exists to leave room
    /// for a future iterating reference-aware fn (none planned in v1); if one is added it
    /// will populate values via the existing `CellEnv::read_range` API. **Step 1.1 (S1-MED-η
    /// closure):** the original comment promised the field "populated when the consumer
    /// iterates"; no consumer does, and the per-fn `ArgContract` only distinguishes Eager
    /// vs LazyShape — it can't express "Eager with materialized Range". A future iterating
    /// fn would need an `ArgContract::EagerWithValues` variant; defer until needed.
    Range { range: Range, values: Vec<Value> },
    /// A single-cell reference carrying only the [`Address`].
    ///
    /// **W5-RT-3.1 (S3-HIGH-1 closure):** the original variant carried a
    /// `value: Value` field intended for fns that wanted both coordinates
    /// AND the dereferenced value. No v1 consumer reads it. The S2-HIGH-2
    /// closure added error-coercion in the CellRef materializer arm to
    /// surface missing-sheet errors as `RefArg::Error(...)`; that fix
    /// inadvertently conflated "the ref's cell happens to hold an error
    /// value" with "the ref is itself invalid", breaking `ISFORMULA(A1)`
    /// when A1 holds a literal `#N/A` or evaluates to `#DIV/0!`. The
    /// right architectural shape — observed in both Step 3 audits
    /// independently — is to NOT read the cell value in the materializer
    /// at all: drop the `value` field, the materializer emits Reference
    /// from address alone, and the per-fn impl queries `read_cell` /
    /// `is_formula_at` / `formula_text_at` directly when it needs the
    /// value. ROW/COLUMN/ROWS/COLUMNS don't need it. ISFORMULA/FORMULATEXT
    /// query formula-status / formula-text via `ReferenceQuery`, not via
    /// the cell's evaluated value. Missing-sheet errors are caught at
    /// bind time (`BindError::UnknownSheet`), not at eval time — so the
    /// hypothetical case that motivated S2-HIGH-2 is closed off
    /// elsewhere.
    Reference { address: Address },
    /// An array literal (`{1,2,3;4,5,6}`) — supports `ROWS`/`COLUMNS` over arrays per
    /// Microsoft canon (HIGH-C closure).
    Array(ArrayValue),
    /// An error propagated from eager evaluation (e.g., `#REF!` from a deleted-cell ref).
    /// Per-fn impls propagate as the first match arm (HIGH-F closure).
    Error(ErrorValue),
    /// **Lazy:** the plan's syntactic shape — no evaluation done. Only ISREF uses this
    /// variant. Carries enough information to distinguish reference / range / function /
    /// literal / error (HIGH-B closure).
    Shape(PlanKind),
}

/// Tagged enum of `ExprPlan` variant kinds for the lazy-shape materializer. Carries just
/// enough information for ISREF to return TRUE iff the source expression's syntactic shape
/// is a reference / range / reference-returning function.
///
/// `Function { returns_reference }` is the reference-returning-fn flag (e.g., OFFSET in
/// future). v1 has no reference-returning fns, so it is always `false` for now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanKind {
    /// `ExprPlan::CellRef` — a single-cell reference.
    CellRef,
    /// `ExprPlan::RangeRef`, `ExprPlan::AggregateNameRef`, or `ExprPlan::StructuredRef` —
    /// a range reference.
    RangeRef,
    /// `ExprPlan::Function { .. }`. `returns_reference` reflects the called fn's ABI; v1
    /// has no reference-returning fns, so this is always false.
    Function { returns_reference: bool },
    /// `ExprPlan::Number`, `ExprPlan::Bool`, `ExprPlan::String`, `ExprPlan::Array`, or
    /// arithmetic plans (`Binary`, `Unary`) — a literal-shaped expression. Not a reference.
    Literal,
    /// `ExprPlan::Error` — an error literal. Not a reference.
    Error,
}

/// Signature for reference-aware functions. Receives [`RefArg`]s materialized per the fn's
/// [`ArgContract`] plus a [`RefContext`] carrying the calling-cell address and a
/// [`ReferenceQuery`] handle for workbook-storage queries.
pub type ReferenceAwareFn = fn(&[RefArg], &RefContext) -> Value;

/// Per-fn ABI metadata. Specifies whether the dispatcher should eagerly evaluate each arg
/// or hand the fn the syntactic plan kind only.
///
/// Today: two variants. Extended in a follow-up phase (per design § 4.A trigger 3) for
/// per-arg-position contracts (e.g., XLOOKUP arg 2 is range, args 1/3/4 are scalar).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArgContract {
    /// All args eager-evaluated. Non-reference args become [`RefArg::Scalar`] (or
    /// [`RefArg::Error`] if the eval produced an error). Used by ROW, COLUMN, ROWS,
    /// COLUMNS, ISFORMULA, FORMULATEXT.
    Eager,
    /// Single-arg fns whose arg is NOT evaluated. The arg becomes [`RefArg::Shape`]
    /// carrying the plan's variant kind. Used by ISREF.
    LazyShape,
}

/// Call-time context for reference-aware functions.
///
/// `formula_cell` reuses the existing `CellEnv::formula_cell_for_sref()` accessor rather
/// than introducing a parallel `CallSite` type (MEDIUM-β closure). It is `None` in test
/// envs / non-cell evaluation paths; consuming fns must handle that (e.g., `ROW()` with
/// no arg returns `#REF!` if `formula_cell` is `None`).
///
/// `workbook` is a `&dyn ReferenceQuery`. The dispatcher obtains it from
/// `CellEnv::reference_query()`; the default impl returns the no-op singleton, and
/// `WorkbookEnv` overrides to delegate to the underlying `&Workbook`.
pub struct RefContext<'a> {
    pub eval_ctx: &'a EvalContext,
    pub formula_cell: Option<Address>,
    pub workbook: &'a dyn ReferenceQuery,
}

impl<'a> RefContext<'a> {
    pub fn new(
        eval_ctx: &'a EvalContext,
        formula_cell: Option<Address>,
        workbook: &'a dyn ReferenceQuery,
    ) -> Self {
        Self {
            eval_ctx,
            formula_cell,
            workbook,
        }
    }
}

/// Workbook-introspection trait for reference-aware functions.
///
/// `WorkbookEnv` (in `ql-exec`) impls this delegating to `ql_storage::Workbook::formula_at`.
/// `MapEnv` and test envs inherit the no-op default via [`NoOpReferenceQuery`].
///
/// Methods are `&self` so the trait object can be stored in a `RefContext` without
/// requiring interior mutability.
pub trait ReferenceQuery {
    /// Returns `true` iff the cell at `(sheet, row, col)` stores a formula. Returns `false`
    /// for literal-bearing cells, empty cells, and out-of-bounds addresses.
    fn is_formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> bool;

    /// Returns the canonical formula text **with leading `=`** (e.g., `"=SUM(B1:B3)"`),
    /// if the cell at `(sheet, row, col)` stores a formula. Returns `None` otherwise.
    ///
    /// The leading `=` is included by the implementation, NOT by the caller — this keeps
    /// the trait surface Excel-canonical. `Workbook::formula_at` stores the canonical
    /// printer output without `=`; the `Workbook` impl of this trait prepends `=` before
    /// returning.
    fn formula_text_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<String>;
}

/// Default [`ReferenceQuery`] impl for envs without workbook backing. Returns `false`
/// for `is_formula_at` and `None` for `formula_text_at`. Used by `MapEnv` test mocks and
/// any other env that doesn't carry a real workbook.
pub struct NoOpReferenceQuery;

impl ReferenceQuery for NoOpReferenceQuery {
    fn is_formula_at(&self, _: SheetId, _: RowId, _: ColId) -> bool {
        false
    }
    fn formula_text_at(&self, _: SheetId, _: RowId, _: ColId) -> Option<String> {
        None
    }
}

/// Singleton instance of [`NoOpReferenceQuery`] for `CellEnv::reference_query()` default
/// returns. Statics are `Sync` automatically since `NoOpReferenceQuery` is a unit struct.
pub static NO_OP_REFERENCE_QUERY: NoOpReferenceQuery = NoOpReferenceQuery;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_op_reference_query_returns_defaults() {
        let q = NoOpReferenceQuery;
        assert!(!q.is_formula_at(0, 0, 0));
        assert!(q.formula_text_at(0, 0, 0).is_none());
    }

    #[test]
    fn no_op_reference_query_singleton_is_usable() {
        let q: &dyn ReferenceQuery = &NO_OP_REFERENCE_QUERY;
        assert!(!q.is_formula_at(1, 2, 3));
        assert!(q.formula_text_at(1, 2, 3).is_none());
    }

    #[test]
    fn ref_arg_variants_construct() {
        // Smoke test: all six variants are constructible.
        let _ = RefArg::Scalar(Value::number(1.0));
        let _ = RefArg::Range {
            range: Range::new(0, 0, 0, 2, 2),
            values: vec![],
        };
        let _ = RefArg::Reference {
            address: Address::new(0, 0, 0),
        };
        let _ = RefArg::Array(
            ArrayValue::new(1, 1, vec![Value::number(1.0)]).expect("1x1 array constructs"),
        );
        let _ = RefArg::Error(ErrorValue::Ref);
        let _ = RefArg::Shape(PlanKind::CellRef);
    }

    #[test]
    fn arg_contract_variants_distinct() {
        assert_ne!(ArgContract::Eager, ArgContract::LazyShape);
    }

    #[test]
    fn plan_kind_function_returns_reference_distinction() {
        assert_ne!(
            PlanKind::Function {
                returns_reference: true
            },
            PlanKind::Function {
                returns_reference: false
            },
        );
        assert_ne!(PlanKind::CellRef, PlanKind::RangeRef);
    }

    /// **W5-RT-1 (RT-V1-01):** registering a reference-aware fn round-trips
    /// through the registry — `lookup_reference_aware` returns the same fn
    /// pointer and contract, and `reference_aware_names` includes the name.
    /// Other tier-specific lookups (`lookup`, `lookup_range_aware`,
    /// `lookup_context_aware`, `lookup_unified`) do NOT find it.
    #[test]
    fn registry_round_trip_for_reference_aware() {
        use crate::FunctionRegistry;

        // Placeholder reference-aware fn — used only as a registration sentinel.
        fn placeholder(_args: &[RefArg], _ctx: &RefContext) -> Value {
            Value::number(42.0)
        }

        let mut reg = FunctionRegistry::new();
        reg.register_reference_aware("__RT_TEST__", placeholder, ArgContract::Eager);

        // Round-trip lookup.
        let Some((looked_up, contract)) = reg.lookup_reference_aware("__RT_TEST__") else {
            panic!("expected registered reference-aware fn");
        };
        assert_eq!(contract, ArgContract::Eager);

        // The dispatcher constructs args + ctx; smoke-test the fn pointer
        // returns the expected sentinel value.
        let ctx = RefContext::new(
            &ql_types::DEFAULT_EVAL_CONTEXT,
            None,
            &NO_OP_REFERENCE_QUERY,
        );
        assert_eq!(looked_up(&[], &ctx), Value::number(42.0));

        // Disjointness: other tier lookups do not find it.
        assert!(reg.lookup("__RT_TEST__").is_none());
        assert!(reg.lookup_range_aware("__RT_TEST__").is_none());
        assert!(reg.lookup_context_aware("__RT_TEST__").is_none());
        assert!(reg.lookup_unified("__RT_TEST__").is_none());

        // Iterator surfaces include the new tier.
        let names: Vec<_> = reg.reference_aware_names().collect();
        assert_eq!(names, vec![&"__RT_TEST__"]);
        let all_names: Vec<_> = reg.names_all().collect();
        assert_eq!(all_names, vec![&"__RT_TEST__"]);
    }

    /// **W5-RT-1 (RT-V1-01):** duplicate registration panics — same canonical
    /// invariant as the other `register_*` methods. Pinned so a future
    /// refactor doesn't accidentally make reference-aware silently override.
    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn register_reference_aware_rejects_duplicate() {
        use crate::FunctionRegistry;
        fn placeholder(_args: &[RefArg], _ctx: &RefContext) -> Value {
            Value::Blank
        }
        let mut reg = FunctionRegistry::new();
        reg.register_reference_aware("__RT_DUP__", placeholder, ArgContract::Eager);
        // Second registration of same name must panic.
        reg.register_reference_aware("__RT_DUP__", placeholder, ArgContract::LazyShape);
    }

    /// **W5-RT-1 (RT-V1-01):** lower-case name registration panics per the
    /// canonical-upper-case invariant shared with `register_*` siblings.
    #[test]
    #[should_panic(expected = "canonical upper-case")]
    fn register_reference_aware_rejects_lowercase() {
        use crate::FunctionRegistry;
        fn placeholder(_args: &[RefArg], _ctx: &RefContext) -> Value {
            Value::Blank
        }
        let mut reg = FunctionRegistry::new();
        reg.register_reference_aware("rt_lowercase", placeholder, ArgContract::Eager);
    }
}
