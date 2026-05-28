//! Function metadata — the 6.4-0 substrate shape (contract §10.2).
//!
//! **Status (2026-05-28): SUBSTRATE SHIPPED.** `FunctionRegistry` now carries
//! `metadata: HashMap<String, FunctionMetadata>` (`ql-functions/src/registry.rs`),
//! populated for every builtin via `register_builtin_metadata` at boot. The
//! two prior whitelists in `calcgraph_session.rs` (`is_volatile_function`,
//! `is_address_only_reference_fn`) are now thin migration shims that read
//! `metadata.volatility ∈ {Volatile, Dynamic}` and `metadata.dep_shape ==
//! AddressOnly` respectively — behavior is preserved byte-for-byte against the
//! prior hardcoded matchers. `FormulaDeps` gained `functions_used: Vec<Arc<str>>`
//! and `CalcgraphSession` gained `functions_used: HashMap<Arc<str>,
//! HashSet<NodeId>>` + two hooks (`on_function_registered` /
//! `on_function_unregistered`) for contract §10.3 registration-invalidation.
//! This DTO is the binding-neutral shape the (forthcoming, 6.4) trait method
//! `EngineSession::register_function` accepts; the substrate hooks at 6.4-0
//! are dirty-only — re-extraction lands at the 6.4 orchestrator level via
//! either a PlanCache `fn_gen` counter (mirror `name_gen`) or per-dependent
//! `reextract_deps` calls in `WorkbookSession::register_function`. See
//! `docs/api/session-api.md` §10 and
//! `docs/audits/2026-05-28-6-4-0-substrate-audit/SYNTHESIS.md`.

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
    /// Address-only (ROW/COLUMN/ROWS/COLUMNS/ISREF): depends on address/shape,
    /// not value.
    AddressOnly,
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
    /// Provenance tags emitted on `Provenance` events (contract §9).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provenance_tags: Vec<String>,
}
