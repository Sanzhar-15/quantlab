//! Function metadata — the 6.4-0 substrate shape (contract §10.2).
//!
//! **Status (2026-05-28): SUBSTRATE SHIPPED + 6.4-1 SUBSTRATE-COMPLETION
//! LANDED.** `FunctionRegistry` carries `metadata: HashMap<String,
//! FunctionMetadata>` (`ql-functions/src/registry.rs`), populated for every
//! builtin via `register_builtin_metadata` at boot.
//!
//! **6.4-0 substrate (2026-05-28):** the two prior whitelists in
//! `calcgraph_session.rs` (`is_volatile_function`,
//! `is_address_only_reference_fn`) became thin migration shims that read
//! `metadata.volatility ∈ {Volatile, Dynamic}` and `metadata.dep_shape ==
//! AddressOnly` respectively — behavior preserved byte-for-byte against the
//! prior hardcoded matchers. `FormulaDeps` gained `functions_used:
//! Vec<Arc<str>>` and `CalcgraphSession` gained `functions_used:
//! HashMap<Arc<str>, HashSet<NodeId>>` + two hooks (`on_function_registered`
//! / `on_function_unregistered`) for contract §10.3 registration-
//! invalidation.
//!
//! **6.4-1 substrate-completion (2026-05-28):** the two REMAINING
//! whitelists in `ql-exec::plan` (`is_aggregate_function` `:406-505`,
//! `is_reference_aware_function` `:566-571`) — which drove the binder's
//! `arg_ctx` decision — now also derive from metadata. This required a new
//! [`ArgContext`] axis (the binder-admission category), distinct from
//! [`BatchShape`] (the eval-time call ABI — UDFs are `ArrayBatch`, builtin
//! aggregates are still per-cell `Scalar` calls even though the binder
//! admits range args). I1 added [`DepShape::LazyShape`] for ISREF so the
//! walker's hardcoded `name == "ISREF"` short-circuit becomes metadata-
//! derived. H3 added a PlanCache `fn_gen: u64` counter mirroring
//! `name_gen`, so a `register_metadata` / `unregister_metadata` call
//! invalidates the bind cache and the next eval re-extracts deps with the
//! current metadata. The substrate hooks remain dirty-only at the
//! `CalcgraphSession` layer — the H3 closure is the cache invalidation,
//! not a per-dependent `reextract_deps` call.
//!
//! ## Metadata-update atomicity (I2)
//!
//! v1 policy is the **two-step contract**: clients MUST call
//! `unregister_metadata(canonical_name)` then `register_metadata(new_meta)`
//! to update an existing entry; there is NO atomic `update_metadata`
//! today. The transient window between the two calls leaves the function
//! in the "unknown" state — formulas referencing it bind / re-bind with
//! `Volatility::Dynamic` (the conservative default in contract §10.3), so
//! the engine never serves a result computed against stale metadata. The
//! binder's `arg_ctx` falls back to `Scalar` during the gap (a `=MYUDF(A1:
//! A10)` call would surface `BindError::NamedRangeInScalarContext`); this
//! is acceptable because (a) UDFs register at workspace-trust elevation,
//! a transient window during a known reload event; (b) atomic in-place
//! swap on a HashMap is straightforward to add when a real UDF live-edit
//! flow needs it, and the two-step path keeps the substrate small. 6.4
//! may add `update_metadata` as a non-breaking superset; the two-step
//! path remains supported.
//!
//! Cross-refs: `docs/api/session-api.md` §10 (function metadata contract),
//! `docs/phase6/6-4-entry-plan.md` §2 (the H1+H3+M+I scope of 6.4-1),
//! `docs/audits/2026-05-28-6-4-0-substrate-audit/SYNTHESIS.md` (substrate
//! audit + the 6.4-1 dispositions).

use serde::{Deserialize, Serialize};

/// How many arguments a function takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Arity {
    /// Exactly `n` arguments.
    Fixed {
        /// The arity.
        n: u8,
    },
    /// Between `min` and (optional) `max` arguments.
    Range {
        /// Minimum.
        min: u8,
        /// Maximum (None = unbounded).
        max: Option<u8>,
    },
    /// Any number of arguments.
    Variadic,
}

/// Whether a function's result can change independently of its arguments.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Volatility {
    /// Same args ⇒ same result; recomputes only on input change.
    Pure,
    /// Recomputes on every recalc / volatile pass (NOW, RAND, …).
    Volatile,
    /// Result depends on workbook structure, not just args (INDIRECT, OFFSET);
    /// the conservative default for an unregistered/unknown function so it stays
    /// graph-visible and never silently Pure (contract §10.3).
    Dynamic,
}

/// How a function's arguments map to graph dependencies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DepShape {
    /// Normal value-deps (the default): referenced cells/ranges are deps.
    ValueDeps,
    /// Address-only (ROW / COLUMN / ROWS / COLUMNS): depends on address /
    /// shape, not value. The walker recurses for Binary / Unary / Function
    /// sub-trees because the eager materializer DOES evaluate those (so
    /// `ROW(A1+1)` must keep A1's value-dep), but skips value-deps on
    /// direct CellRef / RangeRef arguments.
    AddressOnly,
    /// **6.4-1 (2026-05-28; I1):** lazy syntactic-shape inspection (ISREF).
    /// The function never evaluates its arg — it inspects the syntactic
    /// shape via `materialize_ref_arg_lazy`. The walker MUST NOT recurse:
    /// `ISREF(NOW())` must not mark the formula volatile; `ISREF(A1+1)`
    /// must not register `A1` as a dep. Pre-6.4-1 this was a hardcoded
    /// `name == "ISREF"` short-circuit at the walker's `Function` arm; the
    /// I1 closure moves the decision to metadata so 6.4 UDFs declaring
    /// `dep_shape: LazyShape` get the same treatment without engine-side
    /// name special-casing.
    LazyShape,
    /// Caller supplies explicit deps at registration (`register_formula_function(
    /// ..., deps=[...])`).
    Custom,
}

/// Whether a function is called per-cell (scalar) or batch-shaped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchShape {
    /// One call per cell.
    Scalar,
    /// Arrow/array batch — UDFs use this from day one (contract §3.7 / decision-lock).
    ArrayBatch,
}

/// Argument strictness/coercion policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArgPolicy {
    /// Reject type mismatches.
    Strict,
    /// Coerce per the engine's coercion rules.
    Coercing,
}

/// **6.4-1 (2026-05-28; H1):** the binder's arg-admission category for this
/// function. Mirrors the engine-internal `BindContext` enum at
/// `ql-exec::plan` — kept as a separate DTO axis because:
///
/// 1. `BindContext` is internal to `ql-exec` and not part of the binding-
///    neutral wire contract; the metadata DTO must own its own taxonomy.
/// 2. The distinction is orthogonal to [`BatchShape`] (the eval-time call
///    ABI). A scalar aggregate like `SUM` is `ArgContext::Aggregate`
///    (binder admits range args) AND `BatchShape::Scalar` (eval calls
///    `fn(&[Value]) -> Value` per cell after the named-range cache hit).
///    Conflating the two would force Python UDFs that want range args to
///    declare `BatchShape::ArrayBatch`, which has separate semantics
///    around the Arrow IPC ABI.
///
/// Pre-6.4-1 this lived as two parallel `matches!` whitelists in
/// `ql-exec::plan` (`is_aggregate_function`, `is_reference_aware_function`);
/// 6.4-1 moves the decision to metadata so UDFs participating in the
/// binder follow the same lookup path as builtins.
///
/// The default is [`ArgContext::Scalar`] — matches the binder's
/// `else` arm before 6.4-1, and matches the conservative behavior for an
/// unknown function (range args are rejected with
/// `BindError::NamedRangeInScalarContext` rather than silently accepted).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArgContext {
    /// Rejects range args — `BindContext::Scalar`. The vast majority of
    /// builtins (ABS, SQRT, IF, …) and the binder's `else` arm for
    /// unknown names live here.
    #[default]
    Scalar,
    /// Admits named-range / range-aware args — `BindContext::AggregateArg`.
    /// Pre-6.4-1 list at `ql-exec::plan::is_aggregate_function`
    /// (~100 names: scalar aggregates SUM/AVERAGE/COUNT/MIN/MAX/…,
    /// range-aware lookups VLOOKUP/INDEX/MATCH/…, conditional aggregates
    /// SUMIF/AVERAGEIFS/…, array-tier TRANSPOSE/FILTER, range-aware text
    /// CONCAT/TEXTJOIN, financial NPV/IRR/XIRR, statistical CORREL/
    /// COVARIANCE.P/SLOPE/…, order statistics PERCENTILE.*/QUARTILE.*,
    /// SUBTOTAL).
    Aggregate,
    /// Admits literal references (CellRef / RangeRef / NameRef) —
    /// `BindContext::ReferenceArg`. Pre-6.4-1 list at
    /// `ql-exec::plan::is_reference_aware_function` (ROW / COLUMN / ROWS /
    /// COLUMNS / ISREF / ISFORMULA / FORMULATEXT).
    Reference,
}

/// How an in-flight call to this function is canceled (contract §6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelPolicy {
    /// Checked cooperatively at safe points.
    Cooperative,
    /// Hard cancel by killing the worker process (Python UDF / AI; contract §6.2).
    WorkerKill,
    /// Cannot be canceled once started.
    NonCancelable,
}

/// First-class per-function metadata (contract §10.2). Built-ins register their
/// true metadata; UDFs register theirs. The `canonical_name` is ASCII-uppercase,
/// matching the parser's canonicalization (`ql-formula-syntax`); collision +
/// invalidation rules are in contract §10.3.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FunctionMetadata {
    /// Canonical (ASCII-uppercase) name — the graph/lookup key.
    pub canonical_name: String,
    /// Optional display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Optional aliases (also canonicalized).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    /// Argument count.
    pub arity: Arity,
    /// Volatility class.
    pub volatility: Volatility,
    /// Whether same args ⇒ same result.
    pub determinism: bool,
    /// Dependency shape.
    pub dep_shape: DepShape,
    /// Batch/scalar call shape.
    pub batch_shape: BatchShape,
    /// Argument strictness.
    pub arg_policy: ArgPolicy,
    /// Cancellation policy.
    pub cancellation: CancelPolicy,
    /// **6.4-1 (2026-05-28; H1):** the binder's arg-admission category.
    /// Drives `BindContext::{Scalar | AggregateArg | ReferenceArg}` at
    /// `ql-exec::plan`. `#[serde(default)]` so v0 wire bytes (6.4-0 era,
    /// before this field existed) deserialize cleanly with the
    /// conservative [`ArgContext::Scalar`] default — matching the
    /// binder's `else` arm for unknown functions. See the [`ArgContext`]
    /// docs for the migration path off the prior `matches!` whitelists.
    #[serde(default)]
    pub arg_context: ArgContext,
    /// Provenance tags emitted on `Provenance` events (contract §9).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provenance_tags: Vec<String>,
}
