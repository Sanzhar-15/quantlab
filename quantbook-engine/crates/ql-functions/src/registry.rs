//! Function registry — name → implementation dispatch.
//!
//! Names are stored uppercase per Excel canon. Lookup is case-insensitive: the caller
//! can pass `"sum"`, `"SUM"`, or `"Sum"` and get the same function.
//!
//! ## Storage shape (W5-96 / Phase 4.7.B unification)
//!
//! Pre-W5-96 the registry held three parallel `HashMap`s, one per function
//! tier (`ScalarFn`, `RangeAwareFn`, `ContextAwareFn`). Phase 4.7 needs a
//! fourth tier (array-returning functions for SEQUENCE / FILTER /
//! TRANSPOSE), and Codex design review HIGH-1 flagged the proliferation:
//! the right move at this point is to **unify** the dispatch table into
//! one map keyed by name, valued by a `RegisteredFn` enum that tags the
//! tier. Eval-site dispatch becomes one HashMap lookup + one `match`.
//!
//! This commit (W5-96) restructures STORAGE without changing the public
//! `register_*` / `lookup_*` API surface: legacy callers still call
//! `register("SUM", sum_fn)` and `lookup("SUM")` exactly as before. The
//! lookup methods filter on the enum variant (e.g. `lookup_range_aware`
//! returns `Some(raf)` only if the registered fn is
//! `RegisteredFn::RangeAware(raf)`). Eval-site migration to a single
//! match-on-enum lands in W5-101 (Phase 4.7.G) when the array-eval path
//! actually needs it.
//!
//! New array-returning functions register via `register_unified(name,
//! FunctionFn)` and are stored as `RegisteredFn::Unified(_)`. Eval-site
//! dispatch in W5-101 will route them through a new `match` arm that
//! returns `EvalResult::Array(_)` to the runtime.

use std::collections::HashMap;

use ql_session::function_meta::{
    ArgContext, ArgPolicy, Arity, BatchShape, CancelPolicy, DepShape, FunctionMetadata, Volatility,
};
use ql_session::session::FunctionImplHandle;
use ql_types::{ArrayValue, EvalContext, Value};

use crate::context_aware_fns::ContextAwareFn;
use crate::range_aware_fns::RangeAwareFn;
use crate::reference_aware_fns::{ArgContract, ReferenceAwareFn};
use crate::{
    date_fns, distribution_fns, financial_fns, format, range_fns, reference_fns, scalar_fns,
    volatile,
};

/// **6.4-0 (2026-05-28):** registry-level error type for the new
/// metadata-only registration methods (`register_metadata` /
/// `unregister_metadata`). Dispatch-side registration (`register`,
/// `register_range_aware`, …) still panics on collision because the
/// builtin-population path has no recoverable failure mode — a duplicate
/// `r.register("SUM", …)` is a programming bug, not a runtime condition.
///
/// The metadata side is different: UDFs register at runtime under the
/// `EngineSession::register_function` trait method (6.4) which must
/// translate this enum into the contract-specified `EngineError`
/// (`Conflict / function_exists`, `NotFound / function_not_found`) per
/// `docs/api/session-api.md` §10.3. Returning errors here keeps the
/// fail-loud contract (No-Fallbacks rule) without panicking the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FunctionRegistryError {
    /// `register_metadata` saw a canonical name that is already present
    /// (built-in or existing UDF). Carries the offending name verbatim.
    Conflict { name: String },
    /// `unregister_metadata` was called for a name with no metadata
    /// entry — never a silent no-op (would mask a typo that becomes
    /// "leaked stale metadata" once 6.4 lands UDFs).
    NotFound { name: String },
}

impl std::fmt::Display for FunctionRegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict { name } => {
                write!(f, "function metadata already registered for {name:?}")
            }
            Self::NotFound { name } => {
                write!(f, "no function metadata registered for {name:?}")
            }
        }
    }
}

impl std::error::Error for FunctionRegistryError {}

/// Function signature: pre-evaluated args → result Value.
pub type ScalarFn = fn(&[Value]) -> Value;

/// **W5-96 (Phase 4.7.B):** unified function-dispatch arg, used by the
/// new array-returning function tier (`FunctionFn`). Covers all three
/// shapes the eval site can produce:
///
/// - `Scalar(Value)` — single pre-evaluated value (analogous to a single
///   slot in `&[Value]` for the legacy `ScalarFn`).
/// - `Range { values, rows, cols }` — flat row-major iteration over a
///   workbook range, with 2D shape preserved (matches `FnArg::Range`
///   from the legacy `RangeAwareFn` contract).
/// - `Array(ArrayValue)` — an explicit array value from `Expr::Array`
///   literal or another function's return. Distinct from `Range`
///   because `Range` carries workbook-range provenance (used by
///   VLOOKUP/INDEX shape addressing) while `Array` is a free-floating
///   2D value.
///
/// Conversion `FnArg → FunctionArg`:
/// - `FnArg::Scalar(v)` → `FunctionArg::Scalar(v)`.
/// - `FnArg::Range { values, rows, cols }` → `FunctionArg::Range { ... }`.
///
/// The eval site (W5-101 / Phase 4.7.G) materializes `FunctionArg` from
/// `ExprPlan` arg positions before dispatching through `FunctionFn`.
#[derive(Clone, Debug, PartialEq)]
pub enum FunctionArg {
    /// Single scalar value.
    Scalar(Value),
    /// 2D range with explicit shape; `values.len() == rows * cols`,
    /// row-major iteration. Matches the existing `FnArg::Range` shape.
    Range {
        values: Vec<Value>,
        rows: usize,
        cols: usize,
    },
    /// Array value (from `Expr::Array` literal or another function's
    /// `FunctionReturn::Array`).
    Array(ArrayValue),
}

/// **W5-96 (Phase 4.7.B):** unified function return — either a scalar or
/// an array. Arrays returned at the cell-boundary context spill; arrays
/// returned in scalar context produce `Value::Error(ErrorValue::Calc)`
/// (Phase 4.7.G enforces this at the eval site per design § 6.3).
#[derive(Clone, Debug, PartialEq)]
pub enum FunctionReturn {
    Scalar(Value),
    Array(ArrayValue),
}

impl FunctionReturn {
    /// True if this is `Array(_)`. Helper for the eval-site spill check.
    pub fn is_array(&self) -> bool {
        matches!(self, FunctionReturn::Array(_))
    }
}

/// **W5-96 (Phase 4.7.B):** unified function call context. Carries the
/// `EvalContext` (date_system / locale / now_provider) that the legacy
/// `ContextAwareFn` received as a bare reference. Struct-of-fields shape
/// lets us add workbook-level state later (W5-101+) without changing the
/// function ABI.
pub struct FunctionContext<'a> {
    pub eval_ctx: &'a EvalContext,
}

impl<'a> FunctionContext<'a> {
    pub fn new(eval_ctx: &'a EvalContext) -> Self {
        Self { eval_ctx }
    }
}

/// **W5-96 (Phase 4.7.B):** unified function ABI. New array-returning
/// functions (SEQUENCE, FILTER, TRANSPOSE — Phase 4.7.M/N) register
/// through this signature.
pub type FunctionFn = fn(&[FunctionArg], &FunctionContext) -> FunctionReturn;

/// **W5-96 (Phase 4.7.B):** tagged-union of all four function-dispatch
/// tiers, stored as the value in the unified `FunctionRegistry` HashMap.
/// Pre-W5-96 the registry held three parallel HashMaps; this enum
/// collapses them and adds the `Unified` variant for array fns.
///
/// Eval-site code in `ql-exec::scalar` currently routes through the
/// legacy filter-views (`lookup_scalar` / `lookup_range_aware` /
/// `lookup_context_aware`); W5-101 (Phase 4.7.G) migrates that site
/// to a single `match` on `RegisteredFn`.
#[derive(Clone, Debug)]
pub enum RegisteredFn {
    /// Legacy `fn(&[Value]) -> Value`. Most functions register here.
    Scalar(ScalarFn),
    /// Range-aware: `fn(&[FnArg]) -> Value`. Used by SUMIF / VLOOKUP /
    /// INDEX etc. that need per-arg range-vs-scalar metadata.
    RangeAware(RangeAwareFn),
    /// Context-aware: `fn(&[Value], &EvalContext) -> Value`. Used by
    /// DATE / NOW / TODAY / WEEKDAY etc. that need workbook EvalContext.
    ContextAware(ContextAwareFn),
    /// Unified ABI (W5-96+). New array-returning functions (Phase
    /// 4.7.M/N) register here.
    Unified(FunctionFn),
    /// **W5-RT-1 (RT-V1-01):** reference-aware tier. The dispatcher passes
    /// `RefArg`s materialized per the fn's [`ArgContract`] — eager
    /// evaluation with address preservation for ROW/COLUMN/ROWS/COLUMNS/
    /// ISFORMULA/FORMULATEXT, or lazy syntactic-shape inspection for ISREF.
    /// See `reference_aware_fns` module for the type definitions and
    /// `docs/architecture/2026-05-17-reference-tier-design.md` for the
    /// design rationale.
    ReferenceAware(ReferenceAwareFn, ArgContract),
}

/// Phase 0 function registry. Built by `default_registry()` with the
/// full built-in set (~130 entries by W5-93).
///
/// **W5-96 (Phase 4.7.B):** internal storage unified into one HashMap
/// keyed by name, valued by `RegisteredFn`. Legacy `register_*` /
/// `lookup_*` methods preserved as filters on the enum variant for
/// backwards-compat (zero diff on the ~130 existing
/// `r.register("SUM", scalar_fns::sum)` lines in `default_registry`).
///
/// **Disjointness:** a single name maps to ONE `RegisteredFn` (the
/// HashMap enforces this naturally). The pre-W5-96 "cross-table
/// disjointness" assertions become "name already registered" — same
/// semantics, simpler implementation.
#[derive(Clone, Debug)]
pub struct FunctionRegistry {
    fns: HashMap<&'static str, RegisteredFn>,
    /// **6.4-0 (2026-05-28):** per-function metadata, indexed by canonical
    /// (ASCII-uppercase) name — the same keying as `fns`. Built-ins
    /// populate this in [`default_registry`] via [`register_builtin_metadata`];
    /// UDFs (6.4) populate it via [`Self::register_metadata`]. Keys are
    /// `String` (not `&'static str` like `fns`) so UDF metadata can carry
    /// owned names without lifetime ceremony at the binding boundary.
    ///
    /// **Migration shim discipline (contract §10.2):** every entry in
    /// `fns` SHOULD have a matching entry here; the
    /// `default_registry_metadata_is_complete_for_every_dispatch_entry`
    /// debug-build invariant test catches drift.
    metadata: HashMap<String, FunctionMetadata>,
    /// **6.4-1 (2026-05-28; H3):** monotonic generation counter that ticks
    /// on every metadata mutation ([`Self::register_metadata`] /
    /// [`Self::unregister_metadata`]). Mirrors `NameTable::generation()` at
    /// `ql-storage`; `PlanCacheKey` (`ql-exec::plan_cache:69-74`) reads it
    /// alongside `name_gen` so the bind cache invalidates on UDF
    /// register / unregister. Closes contract §10.3's "re-extract deps"
    /// half — the 6.4-0 substrate dirties + reschedules; the 6.4-1
    /// `fn_gen` invalidates the bind cache, forcing the next eval to
    /// re-bind through `walk_plan_for_deps` against the current metadata.
    ///
    /// `saturating_add(1)` (rather than `+= 1` / `wrapping_add`) on bump:
    /// `u64::MAX` would require ~10^19 mutations in one session, so
    /// saturation is fine; the alternative (`checked_add` + `expect`) would
    /// surface a panic the user can't act on, and `wrapping_add` would
    /// re-collide with prior cache keys (the failure mode H3 closes!).
    fn_gen: u64,
    /// **6.4-2 (2026-05-28):** opaque dispatch-handle for UDFs, indexed by
    /// canonical (ASCII-uppercase) name — parallel to [`Self::metadata`]
    /// but populated **only for UDFs** (built-ins have no handle; their
    /// dispatch goes through the static [`Self::fns`] table). Stored on
    /// `FunctionRegistry` rather than on `WorkbookSession` so the
    /// substrate stays the single authority on function identity — when
    /// 6.4-3 wires the Python-worker dispatcher, the lookup is one
    /// `registry.udf_handle(name)` call, not a two-table cross-check.
    ///
    /// **Invariant:** every key here also has an entry in [`Self::metadata`]
    /// (the only way to insert is via [`Self::register_udf`], which calls
    /// [`Self::register_metadata`] first; the only way to remove is via
    /// [`Self::unregister_metadata`], which clears both atomically after
    /// the builtin-guard). NO key here ever overlaps with [`Self::fns`]:
    /// the builtin-guard in `unregister_metadata` ensures UDFs never share
    /// a name with a built-in (and `register_udf` runs through the same
    /// `register_metadata` Conflict check that rejects built-in collisions
    /// via metadata-already-present).
    ///
    /// **No `fn_gen` bump on handle-only mutation:** handle inserts /
    /// removals happen ATOMICALLY with metadata mutations through
    /// `register_udf` / `unregister_metadata` (both of which already bump
    /// `fn_gen`). Exposing a stand-alone "set the handle for an existing
    /// metadata entry" path would invite a fn_gen-skew bug; we don't ship
    /// one in v1.
    udf_handles: HashMap<String, FunctionImplHandle>,
}

impl Default for FunctionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl FunctionRegistry {
    /// Empty registry — caller adds functions via `register`. Use `default_registry()`
    /// for the Phase 0 built-in set.
    pub fn new() -> Self {
        Self {
            fns: HashMap::new(),
            metadata: HashMap::new(),
            // **6.4-1 (2026-05-28; H3):** starts at 0. The very first
            // `register_metadata` call bumps to 1; `PlanCacheKey` carries
            // the value at bind time so a cache hit only happens if the
            // metadata snapshot is unchanged since the bind.
            fn_gen: 0,
            // **6.4-2 (2026-05-28):** empty at boot — built-ins have no
            // handle (their dispatch goes through `fns`). UDFs add entries
            // via [`Self::register_udf`].
            udf_handles: HashMap::new(),
        }
    }

    /// **6.4-1 (2026-05-28; H3):** read the metadata generation counter.
    /// Used by `WorkbookSession` (and the test fixture) to populate
    /// `PlanCacheKey::fn_gen` so cache hits are consistent with the
    /// current metadata table. Monotonically increases.
    pub fn fn_generation(&self) -> u64 {
        self.fn_gen
    }

    /// W5-96 internal: assert canonical-uppercase name + insert with
    /// duplicate panic. Single source of truth for all `register_*`
    /// methods. The pre-W5-96 cross-table disjointness checks collapse
    /// to a single "duplicate" panic per the unified map invariant.
    fn insert_or_panic(&mut self, name: &'static str, f: RegisteredFn, method: &'static str) {
        assert!(!name.is_empty(), "{method}: name must not be empty");
        assert!(
            name.bytes().all(|b| !b.is_ascii_lowercase()),
            "{method}: name {name:?} must be canonical upper-case; \
             lookups uppercase the query, so a lower-case key is unreachable"
        );
        let prior = self.fns.insert(name, f);
        assert!(
            prior.is_none(),
            "{method}: duplicate registration for {name:?} — silent override \
             would let a typo replace a built-in"
        );
    }

    // ===== 6.4-0 metadata substrate (contract §10.2/§10.3) ==================

    /// Case-insensitive metadata lookup. Returns `None` if no metadata is
    /// registered under the canonicalized name — the **conservative
    /// caller policy (contract §10.3)** is to treat an unknown function
    /// as `Volatility::Dynamic` (graph-visible, never silently `Pure`)
    /// at the engine layer rather than have the registry pretend to know.
    /// The current `is_volatile_function` / `is_address_only_reference_fn`
    /// callers preserve today's behavior (unknown = NOT volatile / NOT
    /// address-only) for backward compat; 6.4 will tighten the engine-
    /// side conservative default once UDFs land.
    pub fn metadata(&self, name: &str) -> Option<&FunctionMetadata> {
        let upper = name.to_ascii_uppercase();
        self.metadata.get(upper.as_str())
    }

    /// Number of metadata entries registered. Tests use this to assert the
    /// `default_registry` covers every dispatched name.
    pub fn metadata_count(&self) -> usize {
        self.metadata.len()
    }

    /// Register first-class metadata for a function. The `canonical_name`
    /// **must** be ASCII-uppercase (matches the parser's canonicalization);
    /// rejecting a non-uppercase name with `Conflict` would be wrong
    /// (that's bad input, not collision), so this asserts loud — the
    /// caller is expected to pass already-canonical names per contract
    /// §10.3 ("`register_function` normalizes + validates").
    ///
    /// Returns [`FunctionRegistryError::Conflict`] if a metadata entry
    /// already exists for this name (built-in or prior UDF), per the
    /// fail-loud collision rule in contract §10.3. This is the
    /// non-panicking counterpart to [`Self::insert_or_panic`]'s
    /// dispatch-side duplicate panic — UDFs register at runtime where
    /// a panic would abort the host.
    pub fn register_metadata(
        &mut self,
        meta: FunctionMetadata,
    ) -> Result<(), FunctionRegistryError> {
        assert!(
            !meta.canonical_name.is_empty(),
            "FunctionRegistry::register_metadata: canonical_name must not be empty"
        );
        assert!(
            meta.canonical_name.bytes().all(|b| !b.is_ascii_lowercase()),
            "FunctionRegistry::register_metadata: canonical_name {:?} must be \
             canonical upper-case (caller must normalize before calling)",
            meta.canonical_name
        );
        if self.metadata.contains_key(&meta.canonical_name) {
            return Err(FunctionRegistryError::Conflict {
                name: meta.canonical_name,
            });
        }
        self.metadata.insert(meta.canonical_name.clone(), meta);
        // **6.4-1 (2026-05-28; H3):** bump the metadata generation counter
        // so any `PlanCacheKey` minted before this call misses on next
        // lookup. The bind cache invalidation is what closes contract
        // §10.3's "re-extract deps" half — `CalcgraphSession`'s hooks
        // already dirty + reschedule; the cache miss forces re-binding
        // through `walk_plan_for_deps` against the current metadata so
        // `FormulaDeps::is_volatile` / `functions_used` / `is_volatile`
        // / `dep_shape`-driven routing all reflect the new entry. Only
        // bumped on success — a `Conflict` returned above leaves the
        // metadata table state and `fn_gen` both untouched.
        self.fn_gen = self.fn_gen.saturating_add(1);
        Ok(())
    }

    /// Remove metadata for `canonical_name`. Returns
    /// [`FunctionRegistryError::NotFound`] if no entry exists — never a
    /// silent no-op (per No-Fallbacks: a quiet remove would mask a typo
    /// that leaves stale metadata associated with a since-renamed name).
    /// Lookup uppercases the query for symmetry with [`Self::metadata`].
    ///
    /// **6.4-0 audit-fix (2026-05-28; Codex A LOW):** REFUSES to
    /// remove metadata for any name that still has a dispatch entry
    /// in [`Self::fns`]. Without this guard, an unregister-builtin
    /// call would leave dispatch present + metadata absent — a state
    /// the migration-shim invariant (every dispatched fn has metadata)
    /// forbids, and which would silently regress the dep walker for
    /// the affected built-in (unknown-fn semantics). The (6.4)
    /// `WorkbookSession::unregister_function` trait method should
    /// only ever target UDF names (no dispatch entry by construction);
    /// this guard catches a programmer error at the registry layer
    /// rather than silently corrupting the metadata invariant.
    /// Returns [`FunctionRegistryError::Conflict`] (re-using the
    /// existing variant — the conflict is between "remove" and
    /// "dispatch-still-present").
    pub fn unregister_metadata(
        &mut self,
        canonical_name: &str,
    ) -> Result<(), FunctionRegistryError> {
        let upper = canonical_name.to_ascii_uppercase();
        // Guard: refuse to break the dispatch-has-metadata invariant.
        if self.fns.contains_key(upper.as_str()) {
            return Err(FunctionRegistryError::Conflict {
                name: format!(
                    "{canonical_name} is a registered built-in (dispatch entry present); \
                     unregister_metadata must only target UDF metadata"
                ),
            });
        }
        if self.metadata.remove(&upper).is_some() {
            // **6.4-2 (2026-05-28):** symmetric handle cleanup. The
            // builtin-guard above ensures the metadata being removed is
            // UDF-only, so `udf_handles` MAY or MAY NOT carry a matching
            // entry:
            // - YES if the metadata was registered via
            //   [`Self::register_udf`] (the 6.4-2 trait-wiring path) —
            //   handle inserted alongside.
            // - NO if the metadata was registered via the lower-level
            //   [`Self::register_metadata`] (e.g., a test-only path that
            //   bypasses the trait method's combined registration).
            // The `remove` returns `Option`; we ignore the return because
            // a missing handle is NOT an error here — it just means the
            // UDF was metadata-only. The metadata removal already pinned
            // the success-path; the handle removal is a defense-in-depth
            // cleanup that leaves the invariant
            // "every key in `udf_handles` has a matching `metadata` entry"
            // intact even if a future code path registers metadata-only.
            self.udf_handles.remove(&upper);
            // **6.4-1 (2026-05-28; H3):** symmetric `fn_gen` bump on
            // successful removal. A `NotFound` returned below leaves the
            // counter alone (metadata table unchanged → cache stays
            // valid).
            self.fn_gen = self.fn_gen.saturating_add(1);
            Ok(())
        } else {
            Err(FunctionRegistryError::NotFound {
                name: canonical_name.to_string(),
            })
        }
    }

    /// **6.4-2 (2026-05-28):** combined UDF-metadata + dispatch-handle
    /// registration. Used by `WorkbookSession::register_function` (the
    /// 6.4-2 trait-wiring sub-increment); built-ins use the metadata-only
    /// path at boot via [`register_builtin_metadata`].
    ///
    /// **Atomicity:** the metadata insertion happens first (via
    /// [`Self::register_metadata`]); only on its `Ok` does the handle
    /// land in [`Self::udf_handles`]. A `Conflict` from
    /// `register_metadata` short-circuits BEFORE the handle insert, so
    /// the registry never observes a state with a handle but no
    /// metadata (the inverse — metadata without handle — is the normal
    /// state for built-ins and metadata-only test registrations).
    /// `HashMap::insert` itself cannot fail, so once `register_metadata`
    /// succeeds, the handle insertion is infallible.
    ///
    /// **Single `fn_gen` bump:** the bump happens inside
    /// [`Self::register_metadata`]; the handle insertion does NOT add
    /// another bump. Bind cache invalidation is keyed by metadata mutation,
    /// not by handle mutation — UDF dispatch consults the handle table at
    /// eval time, not at bind time.
    ///
    /// Returns the same [`FunctionRegistryError`] taxonomy as
    /// [`Self::register_metadata`]: `Conflict` on duplicate canonical name
    /// (built-in or existing UDF). The `WorkbookSession` trait method
    /// translates this via `map_function_registry_err` to the
    /// contract-§10.3 `EngineError{class:Conflict, code:"function_exists"}`.
    pub fn register_udf(
        &mut self,
        meta: FunctionMetadata,
        handle: FunctionImplHandle,
    ) -> Result<(), FunctionRegistryError> {
        // Stash the canonical name BEFORE `register_metadata` moves `meta`
        // into the table — needed as the `udf_handles` key.
        let canonical_name = meta.canonical_name.clone();
        self.register_metadata(meta)?;
        // `register_metadata` succeeded → metadata is in the table and
        // `fn_gen` ticked. Insert the handle under the same canonical key.
        // HashMap::insert can't fail; the prior value (if any) was already
        // ruled out by the `Conflict` check inside `register_metadata`.
        self.udf_handles.insert(canonical_name, handle);
        Ok(())
    }

    /// **6.4-2 (2026-05-28):** read the dispatch handle for a UDF by
    /// canonical name (case-insensitive — uppercases the query for
    /// symmetry with [`Self::metadata`]). Returns `None` for built-ins
    /// (no handle), for unknown names, and for UDFs registered
    /// metadata-only via the lower-level [`Self::register_metadata`].
    ///
    /// 6.4-3's worker dispatcher will call this at eval time to route
    /// `RegisteredFn::Udf(_)` calls to the Python worker process; v1
    /// substrate just owns the storage.
    pub fn udf_handle(&self, canonical_name: &str) -> Option<FunctionImplHandle> {
        let upper = canonical_name.to_ascii_uppercase();
        self.udf_handles.get(upper.as_str()).copied()
    }

    /// Iterator over every registered `FunctionMetadata`. Used by the
    /// (forthcoming, 6.4) `EngineSession::list_functions` mapper and by
    /// the substrate's own invariant tests. Order is HashMap-arbitrary
    /// at the registry layer — the trait method sorts at the DTO seam
    /// (matching the 6.1C H2 ordering discipline for snapshot DTOs).
    /// For deterministic ordering at the registry layer, use
    /// [`Self::sorted_metadata`] instead.
    pub fn iter_metadata(&self) -> impl Iterator<Item = &FunctionMetadata> {
        self.metadata.values()
    }

    /// **6.4-1 (2026-05-28; M3):** deterministic view over every registered
    /// `FunctionMetadata`, sorted ascending by `canonical_name`. Matches
    /// the 6.1C H2 ordering discipline (Vecs serialized over the wire
    /// MUST be deterministic — a 5-way megaudit caught the snapshot
    /// `formats` non-determinism at exactly this seam). The
    /// (forthcoming, 6.4) `EngineSession::list_functions` mapper consumes
    /// this view; tests that compare metadata snapshots between runs
    /// should also use this rather than `iter_metadata`.
    ///
    /// Allocates a `Vec<&FunctionMetadata>` of registry-len size; cheap
    /// at v1 sizes (260 builtins + UDFs) and called once per
    /// `list_functions` request.
    pub fn sorted_metadata(&self) -> Vec<&FunctionMetadata> {
        let mut v: Vec<&FunctionMetadata> = self.metadata.values().collect();
        v.sort_by(|a, b| a.canonical_name.cmp(&b.canonical_name));
        v
    }

    /// Register a scalar function under `name`. Stored internally as
    /// `RegisteredFn::Scalar(f)`.
    ///
    /// Phase 2A.7 audit M5: `name` MUST already be canonical upper-case. This is
    /// asserted at registration time so a stray `register("sum", ...)` doesn't
    /// silently create an unreachable entry (lookups uppercase the query, so a
    /// lower-case key would never be found). Duplicate registrations also
    /// panic — silent override would let a typo replace a built-in with a buggy
    /// shim. Phase 2 has a closed default function set; if dynamic registration
    /// ever becomes a real use case, swap this for `Result<(), RegisterError>`.
    pub fn register(&mut self, name: &'static str, f: ScalarFn) {
        self.insert_or_panic(name, RegisteredFn::Scalar(f), "FunctionRegistry::register");
    }

    /// W5-53: register a range-aware function under `name`. Stored
    /// internally as `RegisteredFn::RangeAware(f)`. Same canonical-
    /// uppercase requirement + duplicate panic as `register`.
    pub fn register_range_aware(&mut self, name: &'static str, f: RangeAwareFn) {
        self.insert_or_panic(
            name,
            RegisteredFn::RangeAware(f),
            "FunctionRegistry::register_range_aware",
        );
    }

    /// **W5-69 (Phase 4.5.A.0):** register a context-aware function. These
    /// receive `&EvalContext` (date_system + locale + now_provider) in
    /// addition to the standard `&[Value]` args. Stored internally as
    /// `RegisteredFn::ContextAware(f)`.
    pub fn register_context_aware(&mut self, name: &'static str, f: ContextAwareFn) {
        self.insert_or_panic(
            name,
            RegisteredFn::ContextAware(f),
            "FunctionRegistry::register_context_aware",
        );
    }

    /// **W5-96 (Phase 4.7.B):** register a function under the unified
    /// `FunctionFn` ABI. Used by new array-returning functions
    /// (SEQUENCE, FILTER, TRANSPOSE — Phase 4.7.M/N). Stored as
    /// `RegisteredFn::Unified(f)`.
    pub fn register_unified(&mut self, name: &'static str, f: FunctionFn) {
        self.insert_or_panic(
            name,
            RegisteredFn::Unified(f),
            "FunctionRegistry::register_unified",
        );
    }

    /// **W5-RT-1 (RT-V1-01):** register a reference-aware function under
    /// `name` with its per-fn `ArgContract`. Stored as
    /// `RegisteredFn::ReferenceAware(f, contract)`. The dispatcher (in
    /// `ql-exec::scalar`) reads both fields via `lookup_reference_aware`
    /// (or the unified `lookup_any` + match-on-`RegisteredFn`) to decide
    /// whether to eager-evaluate or lazy-shape-inspect each arg. Step 1.1
    /// closure (S1-LOW-1): the previous doc comment referenced a
    /// `contract_of(name)` helper that doesn't exist; corrected here.
    ///
    /// Same canonical-uppercase requirement + duplicate panic as
    /// `register` / `register_range_aware` / `register_context_aware` /
    /// `register_unified`.
    pub fn register_reference_aware(
        &mut self,
        name: &'static str,
        f: ReferenceAwareFn,
        contract: ArgContract,
    ) {
        self.insert_or_panic(
            name,
            RegisteredFn::ReferenceAware(f, contract),
            "FunctionRegistry::register_reference_aware",
        );
    }

    /// Case-insensitive lookup, returning the scalar function if and only
    /// if the registered entry is `RegisteredFn::Scalar(_)`. Other tiers
    /// (range-aware, context-aware, unified) return `None` here — the
    /// caller must check the tier-specific lookup methods.
    pub fn lookup(&self, name: &str) -> Option<ScalarFn> {
        let upper = name.to_ascii_uppercase();
        match self.fns.get(upper.as_str()) {
            Some(RegisteredFn::Scalar(f)) => Some(*f),
            _ => None,
        }
    }

    /// W5-53: case-insensitive lookup, returning the range-aware fn iff
    /// registered as `RegisteredFn::RangeAware(_)`. Callers should check
    /// this BEFORE `lookup` — if a function is range-aware, the dispatch
    /// must construct `Vec<FnArg>` rather than flattening to `Vec<Value>`.
    pub fn lookup_range_aware(&self, name: &str) -> Option<RangeAwareFn> {
        let upper = name.to_ascii_uppercase();
        match self.fns.get(upper.as_str()) {
            Some(RegisteredFn::RangeAware(f)) => Some(*f),
            _ => None,
        }
    }

    /// **W5-69 (Phase 4.5.A.0):** case-insensitive lookup, returning the
    /// context-aware fn iff registered as `RegisteredFn::ContextAware(_)`.
    /// Callers should check this AFTER `lookup_range_aware` but BEFORE
    /// `lookup`. Dispatch order: `range_aware` → `context_aware` → `scalar`.
    pub fn lookup_context_aware(&self, name: &str) -> Option<ContextAwareFn> {
        let upper = name.to_ascii_uppercase();
        match self.fns.get(upper.as_str()) {
            Some(RegisteredFn::ContextAware(f)) => Some(*f),
            _ => None,
        }
    }

    /// **W5-96 (Phase 4.7.B):** case-insensitive lookup for the unified
    /// ABI. Returns `Some(f)` iff the registered entry is
    /// `RegisteredFn::Unified(_)`. Used by the eval-site array-dispatch
    /// path (W5-101 / Phase 4.7.G).
    pub fn lookup_unified(&self, name: &str) -> Option<FunctionFn> {
        let upper = name.to_ascii_uppercase();
        match self.fns.get(upper.as_str()) {
            Some(RegisteredFn::Unified(f)) => Some(*f),
            _ => None,
        }
    }

    /// **W5-RT-1 (RT-V1-01):** case-insensitive lookup for the
    /// reference-aware tier. Returns `Some((f, contract))` iff the
    /// registered entry is `RegisteredFn::ReferenceAware(_, _)`. The
    /// `ArgContract` lets the dispatcher pick eager-vs-lazy
    /// materialization without a second lookup.
    pub fn lookup_reference_aware(&self, name: &str) -> Option<(ReferenceAwareFn, ArgContract)> {
        let upper = name.to_ascii_uppercase();
        match self.fns.get(upper.as_str()) {
            Some(RegisteredFn::ReferenceAware(f, c)) => Some((*f, *c)),
            _ => None,
        }
    }

    /// **W5-96 (Phase 4.7.B):** case-insensitive lookup returning the
    /// `RegisteredFn` enum directly. Lets the eval site perform a
    /// single match-on-tier rather than four sequential `lookup_*`
    /// calls. Migrated callers (W5-101+) use this; pre-W5-96 callers
    /// keep working through the tier-specific filter views above.
    pub fn lookup_any(&self, name: &str) -> Option<&RegisteredFn> {
        let upper = name.to_ascii_uppercase();
        self.fns.get(upper.as_str())
    }

    /// Iterator over names registered as `RegisteredFn::Scalar(_)`.
    /// **W5-96 (Phase 4.7.B):** previously was "names registered in the
    /// scalar HashMap"; the unified storage means we filter by variant.
    ///
    /// **Ordering is UNSTABLE.** Pre-W5-96 each tier had its own
    /// `HashMap` with non-deterministic iteration order; post-W5-96
    /// the order can also shift as entries in other tiers are added
    /// (single combined HashMap). Callers that need a stable order
    /// (e.g. coverage reports, snapshot tests) must collect + sort.
    pub fn names(&self) -> impl Iterator<Item = &&'static str> + '_ {
        self.fns
            .iter()
            .filter(|(_, v)| matches!(v, RegisteredFn::Scalar(_)))
            .map(|(k, _)| k)
    }

    /// W5-65 (Phase 4.4.B; Codex MEDIUM 4 fix): names registered as
    /// `RegisteredFn::RangeAware(_)`.
    pub fn range_aware_names(&self) -> impl Iterator<Item = &&'static str> + '_ {
        self.fns
            .iter()
            .filter(|(_, v)| matches!(v, RegisteredFn::RangeAware(_)))
            .map(|(k, _)| k)
    }

    /// **W5-69 (Phase 4.5.A.0):** names registered as
    /// `RegisteredFn::ContextAware(_)`.
    pub fn context_aware_names(&self) -> impl Iterator<Item = &&'static str> + '_ {
        self.fns
            .iter()
            .filter(|(_, v)| matches!(v, RegisteredFn::ContextAware(_)))
            .map(|(k, _)| k)
    }

    /// **W5-96 (Phase 4.7.B):** names registered as
    /// `RegisteredFn::Unified(_)`. For coverage walks that want to
    /// see the array-returning function set explicitly.
    pub fn unified_names(&self) -> impl Iterator<Item = &&'static str> + '_ {
        self.fns
            .iter()
            .filter(|(_, v)| matches!(v, RegisteredFn::Unified(_)))
            .map(|(k, _)| k)
    }

    /// **W5-RT-1 (RT-V1-01):** names registered as
    /// `RegisteredFn::ReferenceAware(_, _)`. For coverage walks that
    /// want to see the reference-aware function set explicitly.
    pub fn reference_aware_names(&self) -> impl Iterator<Item = &&'static str> + '_ {
        self.fns
            .iter()
            .filter(|(_, v)| matches!(v, RegisteredFn::ReferenceAware(_, _)))
            .map(|(k, _)| k)
    }

    /// W5-65 (Phase 4.4.B): convenience iterator over ALL registered
    /// function names across all tiers. The unified storage makes this
    /// trivial — `keys()` covers every entry without de-duplication.
    pub fn names_all(&self) -> impl Iterator<Item = &&'static str> {
        self.fns.keys()
    }

    pub fn len(&self) -> usize {
        self.fns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.fns.is_empty()
    }
}

/// Phase 0 default registry with the W4-4 built-in function set (22 functions).
pub fn default_registry() -> FunctionRegistry {
    let mut r = FunctionRegistry::new();

    // Aggregates
    r.register("SUM", scalar_fns::sum);
    r.register("AVERAGE", scalar_fns::average);
    r.register("AVG", scalar_fns::average); // Common alias; not Excel-canonical but
                                            // user-friendly. Re-evaluate when Excel
                                            // compat audit lands.
    r.register("COUNT", scalar_fns::count);
    r.register("COUNTA", scalar_fns::counta);
    r.register("MIN", scalar_fns::min);
    r.register("MAX", scalar_fns::max);
    r.register("PRODUCT", scalar_fns::product);

    // Variance + stdev (Welford-backed, A6 spec)
    r.register("VAR", scalar_fns::var_s); // Excel alias for VAR.S in legacy mode.
    r.register("VAR.S", scalar_fns::var_s);
    r.register("VAR.P", scalar_fns::var_p);
    r.register("STDEV", scalar_fns::stdev_s);
    r.register("STDEV.S", scalar_fns::stdev_s);
    r.register("STDEV.P", scalar_fns::stdev_p);

    // Logical
    r.register("IF", scalar_fns::r#if);
    r.register("AND", scalar_fns::and);
    r.register("OR", scalar_fns::or);
    r.register("NOT", scalar_fns::not);
    r.register("IFERROR", scalar_fns::iferror);

    // Phase 4.10.A (W5-163) — logical fillins.
    r.register("IFS", scalar_fns::ifs);
    r.register("IFNA", scalar_fns::ifna);
    r.register("XOR", scalar_fns::xor);
    r.register("SWITCH", scalar_fns::switch);

    // Phase 4.10.C (W5-165) — *A-variant aggregates + info scalars.
    // *A variants (text counts as 0, bool as 0/1).
    r.register("AVERAGEA", scalar_fns::averagea);
    r.register("MAXA", scalar_fns::maxa);
    r.register("MINA", scalar_fns::mina);
    // Info scalars.
    r.register("NA", scalar_fns::na);
    r.register("ERROR.TYPE", scalar_fns::error_type);
    r.register("TYPE", scalar_fns::type_of);
    r.register("ISEVEN", scalar_fns::iseven);
    r.register("ISODD", scalar_fns::isodd);
    r.register("ISNONTEXT", scalar_fns::isnontext);
    r.register("N", scalar_fns::n_value);

    // **W5-D-8 (Phase 4.10 — V1 260 closeout — engineering bit ops):**
    // BITAND / BITOR / BITXOR / BITLSHIFT / BITRSHIFT. Scalar tier.
    // Excel canon: both args in `[0, 2^48 - 1]` integer; shift amount
    // `|s| <= 53`. Negative shift inverts direction. Result overflow
    // → `#NUM!`. Ported from IronCalc `engineering/bit_operations.rs`.
    r.register("BITAND", scalar_fns::bitand);
    r.register("BITOR", scalar_fns::bitor);
    r.register("BITXOR", scalar_fns::bitxor);
    r.register("BITLSHIFT", scalar_fns::bitlshift);
    r.register("BITRSHIFT", scalar_fns::bitrshift);

    // **W5-D-9 (Phase 4.10 — V1 260 closeout — base conversion):**
    // DEC2BIN / DEC2OCT / DEC2HEX (decimal → string) + BIN2DEC /
    // OCT2DEC / HEX2DEC (target base → decimal). Scalar tier.
    // 10-digit two's-complement canon (binary [-512, 511]; octal
    // [-2^29, 2^29-1]; hex [-2^39, 2^39-1]). Ported from IronCalc
    // `engineering/number_basis.rs`.
    r.register("DEC2BIN", scalar_fns::dec2bin);
    r.register("DEC2OCT", scalar_fns::dec2oct);
    r.register("DEC2HEX", scalar_fns::dec2hex);
    r.register("BIN2DEC", scalar_fns::bin2dec);
    r.register("OCT2DEC", scalar_fns::oct2dec);
    r.register("HEX2DEC", scalar_fns::hex2dec);

    // **W5-D-10 (Phase 4.10 — V1 260 closeout — error function
    // family):** ERF / ERF.PRECISE / ERFC / ERFC.PRECISE. Scalar
    // tier. Closed-form via `statrs::function::erf::{erf, erfc}`
    // (Abramowitz-Stegun rational approximation). Companion to GAMMA
    // family from W5-D-5. ERF is variadic (1-2 args; 2 args returns
    // `erf(upper) - erf(lower)` definite-integral form).
    r.register("ERF", distribution_fns::erf_excel);
    r.register("ERF.PRECISE", distribution_fns::erf_precise);
    r.register("ERFC", distribution_fns::erfc_excel);
    r.register("ERFC.PRECISE", distribution_fns::erfc_precise);

    // Phase 4.10.D (W5-166) — combinatorics + SUMSQ (scalar tier).
    r.register("FACT", scalar_fns::fact);
    r.register("FACTDOUBLE", scalar_fns::factdouble);
    r.register("COMBIN", scalar_fns::combin);
    r.register("COMBINA", scalar_fns::combina);
    r.register("PERMUT", scalar_fns::permut);
    r.register("PERMUTATIONA", scalar_fns::permutationa);
    r.register("SUMSQ", scalar_fns::sumsq);

    // Phase 4.10.E (W5-167) — text utility fillins.
    // Scalar — codepoint round-trip.
    r.register("CHAR", scalar_fns::char_fn);
    r.register("CODE", scalar_fns::code_fn);
    r.register("UNICODE", scalar_fns::unicode_fn);
    r.register("UNICHAR", scalar_fns::unichar_fn);

    // Phase 4.10.F (W5-168) — financial TVM family (scalar).
    r.register("PMT", financial_fns::pmt);
    r.register("FV", financial_fns::fv);
    r.register("PV", financial_fns::pv);
    r.register("NPER", financial_fns::nper);
    r.register("RATE", financial_fns::rate);
    r.register("IPMT", financial_fns::ipmt);
    r.register("PPMT", financial_fns::ppmt);

    // Phase 4.10 polish (W5-180) — depreciation batch starter (scalar).
    // SLN + SYD are closed-form formulas with two/three required args.
    r.register("SLN", financial_fns::sln);
    r.register("SYD", financial_fns::syd);

    // Phase 4.10 polish (W5-181) — DDB: double-declining-balance.
    // Closed-form (no period iteration despite the name); optional
    // `factor` arg (default 2). Salvage floor stops depreciation
    // before over-depreciating.
    r.register("DDB", financial_fns::ddb);

    // Phase 4.10 polish (W5-182) — DB: fixed-declining-balance.
    // Period-iterating (each period depends on accumulated book
    // value); Excel-specific 3-decimal rate rounding; optional
    // `month` arg (default 12) for partial first / last periods.
    r.register("DB", financial_fns::db);

    // Phase 4.10 polish (W5-183) — VDB: variable-declining-balance
    // (CLOSES Wave 3 depreciation batch). Period range + DDB-to-SLN
    // crossover + optional no_switch flag. Most complex single
    // function in the depreciation batch. IronCalc has it in docs
    // nav only; ported directly from Microsoft examples.
    r.register("VDB", financial_fns::vdb);

    // Phase 4.10.G (W5-169) — ADDRESS (scalar text formatter).
    r.register("ADDRESS", scalar_fns::address);

    // Math
    r.register("ABS", scalar_fns::abs);
    r.register("SQRT", scalar_fns::sqrt);
    r.register("ROUND", scalar_fns::round);
    r.register("INT", scalar_fns::int);
    r.register("MOD", scalar_fns::r#mod);
    r.register("POWER", scalar_fns::power);

    // AI reservation per CORR-06 / T4-D05 — returns Error(AINotAvailable). See
    // `scalar_fns::ai` doc.
    r.register("AI", scalar_fns::ai);

    // Engine Phase 4.3 V1 (W5-46, 2026-05-13): function library wave 1
    // batch — math + text + information. All scalar (per-cell, no
    // range-arg machinery beyond what 3.6 already provides). Excel-
    // canon error propagation and coercion.
    r.register("ROUNDUP", scalar_fns::roundup);
    r.register("ROUNDDOWN", scalar_fns::rounddown);
    r.register("TRUNC", scalar_fns::trunc);
    r.register("SIGN", scalar_fns::sign);
    r.register("EXP", scalar_fns::exp);
    r.register("LN", scalar_fns::ln);
    r.register("LOG", scalar_fns::log);
    r.register("LOG10", scalar_fns::log10);
    r.register("PI", scalar_fns::pi);
    r.register("DEGREES", scalar_fns::degrees);
    r.register("RADIANS", scalar_fns::radians);
    r.register("LEN", scalar_fns::len);
    r.register("UPPER", scalar_fns::upper);
    r.register("LOWER", scalar_fns::lower);
    r.register("PROPER", scalar_fns::proper);
    r.register("CLEAN", scalar_fns::clean);
    r.register("TRIM", scalar_fns::trim);
    r.register("ISNUMBER", scalar_fns::isnumber);
    r.register("ISTEXT", scalar_fns::istext);
    r.register("ISBLANK", scalar_fns::isblank);
    r.register("ISLOGICAL", scalar_fns::islogical);
    r.register("ISERROR", scalar_fns::iserror);
    r.register("ISNA", scalar_fns::isna);
    r.register("ISERR", scalar_fns::iserr);

    // Engine Phase 4.3 V2 batch #5 — text functions wave 2 (W5-56).
    // All scalar (existing ScalarFn contract). 1-based indices for
    // FIND/SEARCH/MID/REPLACE; UTF-8 char-count semantics (UTF-16
    // canon deferred to a future Phase — Phase 4.9 was R1C1 +
    // locales + `@`, not the UTF-16 work originally anticipated).
    r.register("LEFT", scalar_fns::left);
    r.register("RIGHT", scalar_fns::right);
    r.register("MID", scalar_fns::mid);
    r.register("FIND", scalar_fns::find);
    r.register("SEARCH", scalar_fns::search);
    r.register("SUBSTITUTE", scalar_fns::substitute);
    r.register("REPLACE", scalar_fns::replace_fn);
    r.register("CONCATENATE", scalar_fns::concatenate);
    r.register("REPT", scalar_fns::rept);
    r.register("EXACT", scalar_fns::exact);

    // Engine Phase 4.3 V2 batch #6 — math completion + hyperbolic
    // trig (W5-57). All scalar. Math sign-rule canon for CEILING /
    // FLOOR / MROUND; integer-domain for GCD / LCM / QUOTIENT.
    r.register("CEILING", scalar_fns::ceiling);
    r.register("FLOOR", scalar_fns::floor);
    r.register("CEILING.MATH", scalar_fns::ceiling_math);
    r.register("FLOOR.MATH", scalar_fns::floor_math);
    r.register("MROUND", scalar_fns::mround);
    r.register("ODD", scalar_fns::odd);
    r.register("EVEN", scalar_fns::even);
    r.register("QUOTIENT", scalar_fns::quotient);
    r.register("GCD", scalar_fns::gcd);
    r.register("LCM", scalar_fns::lcm);
    r.register("SINH", scalar_fns::sinh);
    r.register("COSH", scalar_fns::cosh);
    r.register("TANH", scalar_fns::tanh);
    r.register("ASINH", scalar_fns::asinh);
    r.register("ACOSH", scalar_fns::acosh);
    r.register("ATANH", scalar_fns::atanh);

    // Engine Phase 4.3 V2 batch #1 (W5-51, 2026-05-13): trigonometry.
    // All scalar, single-arg except ATAN2 (two args). Inputs/outputs
    // in radians; pair with DEGREES/RADIANS for degree-mode math.
    r.register("SIN", scalar_fns::sin);
    r.register("COS", scalar_fns::cos);
    r.register("TAN", scalar_fns::tan);
    r.register("ASIN", scalar_fns::asin);
    r.register("ACOS", scalar_fns::acos);
    r.register("ATAN", scalar_fns::atan);
    r.register("ATAN2", scalar_fns::atan2);

    // Engine Phase 3.7 (W5-40, 2026-05-12): volatile functions. The
    // `is_volatile_function` whitelist in `ql-exec::calcgraph_session`
    // already covers these names; this registration is the executable
    // half. INDIRECT / OFFSET / INFO / CELL stay deferred to the Phase
    // 4.3 function library expansion. (RANDARRAY's dispatch shipped in
    // Wave O — 2026-06-20 — via the array-returning tier above; it keeps
    // its Volatile metadata from the Phase-1 override below.)
    // **W5-71 (Phase 4.5.A.2):** NOW/TODAY moved to the
    // ContextAwareFn tier so they can read the workbook's date_system
    // + locale-aware UTC offset from `EvalContext`. The legacy
    // `volatile::now` / `volatile::today` scalar functions are kept in
    // the source (deprecated callable API) but no longer registered.
    r.register_context_aware("NOW", volatile::now_ctx);
    r.register_context_aware("TODAY", volatile::today_ctx);
    r.register("RAND", volatile::rand);
    r.register("RANDBETWEEN", volatile::randbetween);

    // **W5-72 (Phase 4.5.B wave 1):** date/time function library —
    // foundational 8 (per W5-68 design § 5.1). DATE/YEAR/MONTH/DAY are
    // ContextAwareFn (need workbook.date_system for serial interp).
    // HOUR/MINUTE/SECOND/TIME are pure scalar (no date_system dep).
    r.register_context_aware("DATE", date_fns::date_ctx);
    r.register_context_aware("YEAR", date_fns::year_ctx);
    r.register_context_aware("MONTH", date_fns::month_ctx);
    r.register_context_aware("DAY", date_fns::day_ctx);
    r.register("HOUR", date_fns::hour);
    r.register("MINUTE", date_fns::minute);
    r.register("SECOND", date_fns::second);
    r.register("TIME", date_fns::time);

    // **W5-73 (Phase 4.5.B wave 2):** date text parsing + month arithmetic +
    // weekday. All ContextAwareFn (date_system aware; TIMEVALUE is locale-
    // technically but consistent tier).
    r.register_context_aware("DATEVALUE", date_fns::datevalue_ctx);
    r.register_context_aware("TIMEVALUE", date_fns::timevalue_ctx);
    r.register_context_aware("WEEKDAY", date_fns::weekday_ctx);
    r.register_context_aware("EOMONTH", date_fns::eomonth_ctx);
    r.register_context_aware("EDATE", date_fns::edate_ctx);

    // **W5-74 (Phase 4.5.B wave 3, CLOSES V1 wave 18/18):** business-date
    // + finance basics. DAYS is ScalarFn (pure subtraction); the rest
    // are ContextAwareFn. Holidays arg unsupported in V1 (see GAP-F-09,
    // GAP-F-10) — 3-arg NETWORKDAYS/WORKDAY returns #VALUE!.
    r.register("DAYS", date_fns::days);
    r.register_context_aware("NETWORKDAYS", date_fns::networkdays_ctx);
    r.register_context_aware("WORKDAY", date_fns::workday_ctx);
    r.register_context_aware("YEARFRAC", date_fns::yearfrac_ctx);

    // **W5-75 (Phase 4.5.C V2 wave, 4 of 6):** date-arithmetic V2 fns.
    // NETWORKDAYS.INTL + WORKDAY.INTL deferred (carry GAP-F-09/10
    // tier-4 dependency).
    r.register_context_aware("DATEDIF", date_fns::datedif_ctx);
    r.register_context_aware("DAYS360", date_fns::days360_ctx);
    r.register_context_aware("WEEKNUM", date_fns::weeknum_ctx);
    r.register_context_aware("ISOWEEKNUM", date_fns::isoweeknum_ctx);

    // **W5-83 (Phase 4.5.E):** `TEXT(value, format_string)` — format a
    // value into a text string per the workbook's number-format grammar.
    // ContextAwareFn because the renderer needs `DateSystem` for the
    // serial→date conversion path. Parser failures + V2-deferred tokens
    // surface as `#VALUE!`. Companion `format::render` shipped W5-78.
    r.register_context_aware("TEXT", format::text_ctx);

    // Phase 4.10.E (W5-167) — locale-aware text utilities.
    r.register_context_aware("VALUE", scalar_fns::value_ctx);
    r.register_context_aware("FIXED", scalar_fns::fixed_ctx);
    r.register_context_aware("DOLLAR", scalar_fns::dollar_ctx);

    // Phase 4.10 polish (W5-173) — NUMBERVALUE: like VALUE but with
    // explicit decimal + group separator args. Trailing `%` divides by
    // 100 per Microsoft canon. Empty/blank text → 0 (NOT #VALUE!).
    r.register_context_aware("NUMBERVALUE", scalar_fns::numbervalue_ctx);

    // Engine Phase 4.3 V2 batch — range-aware (W5-53, GAP-F-05
    // closure). These use the new `RangeAwareFn` table because the
    // existing `ScalarFn = fn(&[Value]) -> Value` contract can't
    // distinguish "this argument is a range" from "this argument is
    // a scalar criteria". The dispatch in
    // `ql-exec::scalar::eval_scalar_with_cache` checks the range-
    // aware table first.
    r.register_range_aware("SUMIF", range_fns::sumif);
    r.register_range_aware("COUNTIF", range_fns::countif);

    // Engine Phase 4.3 V2 batch #3 — lookup family (W5-54). Same
    // RangeAwareFn dispatch as SUMIF/COUNTIF. MATCH/INDEX/VLOOKUP/
    // HLOOKUP need 2D shape (rows, cols) on the range arg; CHOOSE
    // takes only scalar args.
    r.register_range_aware("MATCH", range_fns::r#match);
    r.register_range_aware("INDEX", range_fns::index);
    r.register_range_aware("VLOOKUP", range_fns::vlookup);
    r.register_range_aware("HLOOKUP", range_fns::hlookup);
    r.register_range_aware("CHOOSE", range_fns::choose);

    // Engine Phase 4.3 V2 batch #4 — conditional-aggregate
    // completion (W5-55). Multi-condition variants of SUMIF/COUNTIF
    // + AVERAGEIF / AVERAGEIFS + SUMPRODUCT. All consume
    // RangeAwareFn dispatch.
    r.register_range_aware("AVERAGEIF", range_fns::averageif);
    r.register_range_aware("SUMIFS", range_fns::sumifs);
    r.register_range_aware("COUNTIFS", range_fns::countifs);
    r.register_range_aware("AVERAGEIFS", range_fns::averageifs);
    r.register_range_aware("SUMPRODUCT", range_fns::sumproduct);

    // Phase 4.10.B (W5-164) — conditional-aggregate fillins.
    r.register_range_aware("MINIFS", range_fns::minifs);
    r.register_range_aware("MAXIFS", range_fns::maxifs);
    r.register_range_aware("COUNTBLANK", range_fns::countblank);

    // Phase 4.10.D (W5-166) — paired sum-of-squares (range-aware).
    r.register_range_aware("SUMX2MY2", range_fns::sumx2my2);
    r.register_range_aware("SUMX2PY2", range_fns::sumx2py2);
    r.register_range_aware("SUMXMY2", range_fns::sumxmy2);

    // Phase 4.10.E (W5-167) — TEXTJOIN (range-aware variadic).
    r.register_range_aware("TEXTJOIN", range_fns::textjoin);

    // Phase 4.10.F (W5-168) — financial cash-flow family (range-aware).
    r.register_range_aware("NPV", financial_fns::npv);
    r.register_range_aware("IRR", financial_fns::irr);

    // Phase 4.10 polish (W5-174) — MIRR: closed-form Modified IRR
    // using separate rates for negative (financing) and positive
    // (reinvestment) cash flows. RangeAwareFn; first arg must be range.
    r.register_range_aware("MIRR", financial_fns::mirr);

    // B2 (native quant fns) — beyond-Excel quant aggregates built on the
    // engine's welford stddev/mean primitives. Both RangeAwareFn; arg 0 is
    // the series range. SHARPE = mean(excess returns) / sample-stdev, with
    // optional sqrt(periods) annualization; MAX_DRAWDOWN = max peak-to-trough
    // decline of an equity/price series (negative fraction). See the
    // doc-comments in `financial_fns.rs` for the exact semantics + error
    // contract. Admitted to `is_aggregate_function` via the Phase-1.5
    // ArgContext::Aggregate override list below (otherwise the range arg
    // collapses to an implicitly-intersected scalar at bind time).
    r.register_range_aware("SHARPE", financial_fns::sharpe);
    r.register_range_aware("MAX_DRAWDOWN", financial_fns::max_drawdown);
    // B2 Wave A — two more native quant aggregates on the same welford
    // primitives. VOLATILITY = sample-stdev of returns, optional sqrt(periods)
    // annualization (a constant series ⇒ 0.0, NOT an error — unlike SHARPE's
    // zero denominator); SORTINO = (mean - MAR) / downside-deviation
    // (empyrical all-N downside convention), same sqrt(periods) annualization
    // as SHARPE. Both RangeAwareFn (arg 0 = series range); admitted to the
    // ArgContext::Aggregate override list below alongside SHARPE/MAX_DRAWDOWN.
    r.register_range_aware("VOLATILITY", financial_fns::volatility);
    r.register_range_aware("SORTINO", financial_fns::sortino);

    // **W5-D-7 (Wave 3 closure — CLOSES Wave 3):** XNPV / XIRR —
    // date-indexed cash flow. Both RangeAwareFn with 2 ranges
    // (values + dates). XIRR uses Newton-Raphson on XNPV's
    // derivative with bisection fallback, matching IronCalc's
    // `financial_util.rs` pattern. Closes the final Wave-3-tagged
    // matrix item.
    r.register_range_aware("XNPV", financial_fns::xnpv);
    r.register_range_aware("XIRR", financial_fns::xirr);

    // Phase 4.10 polish (W5-177) — CORREL: Pearson correlation
    // coefficient. RangeAwareFn; both args must be ranges of identical
    // shape. First Wave 3 statistical function ported from IronCalc.
    r.register_range_aware("CORREL", range_fns::correl);

    // Phase 4.10 polish (W5-178) — SLOPE + INTERCEPT: least-squares
    // linear regression. Share `compute_slope` (intercept needs slope
    // first). Note Excel's Y-first arg order: `SLOPE(known_y, known_x)`.
    r.register_range_aware("SLOPE", range_fns::slope);
    r.register_range_aware("INTERCEPT", range_fns::intercept);

    // Phase 4.10 polish (W5-179) — PEARSON + RSQ + STEYX: close the
    // Wave 3 regression batch. PEARSON is mathematically identical to
    // CORREL (Microsoft + IronCalc both confirm); RSQ is CORREL²;
    // STEYX is the standard error of the predicted y (two-pass over
    // the pairs for residuals).
    r.register_range_aware("PEARSON", range_fns::pearson);
    r.register_range_aware("RSQ", range_fns::rsq);
    r.register_range_aware("STEYX", range_fns::steyx);

    // **W5-D-6 (Wave 3 closure — paired-array statistics):**
    // COVARIANCE.P / COVARIANCE.S. Population (divisor n) + sample
    // (divisor n-1) covariance via the shared `compute_covariance`
    // kernel. RangeAwareFn; both args must be ranges of identical
    // shape. Closes the Wave 3 paired-array gap noted in
    // excel-matrix.md alongside CORREL/PEARSON/RSQ/STEYX.
    r.register_range_aware("COVARIANCE.P", range_fns::covariance_p);
    r.register_range_aware("COVARIANCE.S", range_fns::covariance_s);

    // Phase 4.10.G (W5-169) — modern lookups (range-aware).
    r.register_range_aware("XLOOKUP", range_fns::xlookup);
    r.register_range_aware("XMATCH", range_fns::xmatch);

    // Engine Phase 4.3 V2 batch #7 — stats family (W5-58).
    // Closes FN4-01 (100 functions). LARGE/SMALL are k-th order;
    // RANK is 1-based with tie semantics; MEDIAN handles even-count
    // averaging; MODE first-appearance tie-break + #N/A if no repeat.
    r.register_range_aware("LARGE", range_fns::large);
    r.register_range_aware("SMALL", range_fns::small);
    r.register_range_aware("RANK", range_fns::rank);
    r.register_range_aware("RANK.EQ", range_fns::rank); // Modern Excel alias
    r.register_range_aware("RANK.AVG", range_fns::rank_avg);
    r.register_range_aware("CONCAT", range_fns::concat);
    r.register_range_aware("MEDIAN", range_fns::median);
    r.register_range_aware("MODE", range_fns::mode);
    r.register_range_aware("MODE.SNGL", range_fns::mode); // Modern Excel alias

    // **W5-D-11 (Phase 4.10 — V1 260 closeout — order statistics):**
    // PERCENTILE.INC / PERCENTILE.EXC / QUARTILE.INC / QUARTILE.EXC plus
    // the legacy PERCENTILE / QUARTILE aliases (Excel 2010+ ships both
    // names; the legacy form maps to the `.INC` variant per Microsoft
    // canon). Range-aware tier — array sort + linear interpolation.
    // IronCalc does NOT ship these; this is an original port against
    // Microsoft's documented algorithm.
    r.register_range_aware("PERCENTILE.INC", range_fns::percentile_inc);
    r.register_range_aware("PERCENTILE.EXC", range_fns::percentile_exc);
    r.register_range_aware("PERCENTILE", range_fns::percentile_inc); // Legacy alias for .INC
    r.register_range_aware("QUARTILE.INC", range_fns::quartile_inc);
    r.register_range_aware("QUARTILE.EXC", range_fns::quartile_exc);
    r.register_range_aware("QUARTILE", range_fns::quartile_inc); // Legacy alias for .INC

    // **W5-D-12 (Phase 4.10 — V1 260 sealer):** SUBTOTAL — conditional
    // aggregate dispatcher. Routes to AVERAGE/COUNT/COUNTA/MAX/MIN/
    // PRODUCT/STDEV.S/STDEV.P/SUM/VAR.S/VAR.P based on function_num
    // (1..=11). 101..=111 SKIP hidden rows (Wave G2); on an all-visible
    // range they equal 1..=11. Closes Phase 4.10 V1-260 at
    // 260 registered fns.
    r.register_range_aware("SUBTOTAL", range_fns::subtotal);

    // **W5-106 (Phase 4.7.M)**: first array-returning function tier.
    // Returns FunctionReturn::Array at the cell boundary → spills via
    // `WorkbookRuntime::set_formula` / `recompute_all` write_spill path
    // (Phase 4.7.J #128 closure).
    r.register_unified("SEQUENCE", crate::array_returning_fns::sequence);

    // **W5-107 (Phase 4.7.N)**: second + third array-returning
    // functions. TRANSPOSE swaps rows ↔ cols; FILTER returns subset
    // matching a boolean mask.
    r.register_unified("TRANSPOSE", crate::array_returning_fns::transpose);
    r.register_unified("FILTER", crate::array_returning_fns::filter);

    // **Wave O (2026-06-20)**: complete the "top-5" dynamic-array family.
    // SORT / SORTBY / UNIQUE are pure (Phase-2 below synthesizes their default
    // `Pure` metadata). RANDARRAY already carries explicit `Volatile` metadata
    // from the Phase-1 override below; this line adds its DISPATCH (it was
    // metadata-only — the "future wave" the subset-invariant comment names).
    r.register_unified("SORT", crate::array_returning_fns::sort);
    r.register_unified("SORTBY", crate::array_returning_fns::sortby);
    r.register_unified("UNIQUE", crate::array_returning_fns::unique);
    r.register_unified("RANDARRAY", crate::array_returning_fns::randarray);

    // **W5-RT-2 (RT-V1-01 Step 2)**: reference-aware tier — address-only
    // batch. ROW / COLUMN return the 1-indexed row/col of a Reference or
    // Range arg (or of the calling cell if omitted). ROWS / COLUMNS return
    // the row/column count of a Reference / Range / Array literal arg.
    // All four use `ArgContract::Eager` — the dispatcher's eager
    // materializer (S1-HIGH-A walker is shape-aware so deps are correct
    // for nested arithmetic args). See `reference_fns` for the impls and
    // `docs/architecture/2026-05-17-reference-tier-design.md` § 5.6.
    r.register_reference_aware("ROW", reference_fns::row, ArgContract::Eager);
    r.register_reference_aware("COLUMN", reference_fns::column, ArgContract::Eager);
    r.register_reference_aware("ROWS", reference_fns::rows, ArgContract::Eager);
    r.register_reference_aware("COLUMNS", reference_fns::columns, ArgContract::Eager);

    // **W5-RT-3 (RT-V1-01 Step 3)**: reference-aware tier — information
    // batch. ISREF uses `ArgContract::LazyShape` (first user-facing fn
    // through that contract); ISFORMULA uses `Eager` + queries the
    // workbook's `ReferenceQuery::is_formula_at` for formula-status.
    // FORMULATEXT (Step 4) follows the Eager + workbook-query pattern.
    r.register_reference_aware("ISREF", reference_fns::isref, ArgContract::LazyShape);
    r.register_reference_aware("ISFORMULA", reference_fns::isformula, ArgContract::Eager);

    // **W5-RT-4 (RT-V1-01 Step 4 — CLOSES the reference-tier mini-phase)**:
    // FORMULATEXT returns the canonical formula text at a referenced cell,
    // with leading `=` (e.g., `"=SUM(B1:B3)"`). Eager contract + queries
    // `ReferenceQuery::formula_text_at`. Multi-cell range → `#N/A` per
    // Microsoft canon (documented IronCalc divergence).
    r.register_reference_aware(
        "FORMULATEXT",
        reference_fns::formulatext,
        ArgContract::Eager,
    );

    // **W5-D-1 (Wave 3 distributions batch — normal)**: NORM.DIST /
    // NORM.S.DIST / NORM.INV / NORM.S.INV. Scalar tier; statrs::Normal
    // backing matches IronCalc's behavior exactly (both projects pin
    // statrs = 0.18.0). See `distribution_fns` module for canon semantics.
    r.register("NORM.DIST", distribution_fns::norm_dist);
    r.register("NORM.S.DIST", distribution_fns::norm_s_dist);
    r.register("NORM.INV", distribution_fns::norm_inv);
    r.register("NORM.S.INV", distribution_fns::norm_s_inv);

    // **W5-D-2 (Wave 3 distributions batch — Student's t)**: T.DIST /
    // T.DIST.2T / T.DIST.RT / T.INV / T.INV.2T. Scalar tier;
    // statrs::StudentsT backing matches IronCalc's behavior on the
    // numerical kernel (both pin statrs = 0.18.0). Same coercion-frontend
    // divergences as W5-D-1 (Booleans coerced to 0/1 vs IronCalc rejects).
    r.register("T.DIST", distribution_fns::t_dist);
    r.register("T.DIST.2T", distribution_fns::t_dist_2t);
    r.register("T.DIST.RT", distribution_fns::t_dist_rt);
    r.register("T.INV", distribution_fns::t_inv);
    r.register("T.INV.2T", distribution_fns::t_inv_2t);

    // **W5-D-3 (Wave 3 distributions batch — chi-squared + F)**:
    // CHISQ.DIST / CHISQ.DIST.RT / CHISQ.INV / CHISQ.INV.RT +
    // F.DIST / F.DIST.RT / F.INV / F.INV.RT. Scalar tier;
    // statrs::ChiSquared + statrs::FisherSnedecor backing. Same
    // coercion-frontend divergences as W5-D-1 / W5-D-2.
    r.register("CHISQ.DIST", distribution_fns::chisq_dist);
    r.register("CHISQ.DIST.RT", distribution_fns::chisq_dist_rt);
    r.register("CHISQ.INV", distribution_fns::chisq_inv);
    r.register("CHISQ.INV.RT", distribution_fns::chisq_inv_rt);
    r.register("F.DIST", distribution_fns::f_dist);
    r.register("F.DIST.RT", distribution_fns::f_dist_rt);
    r.register("F.INV", distribution_fns::f_inv);
    r.register("F.INV.RT", distribution_fns::f_inv_rt);

    // **W5-D-4 (Wave 3 distributions batch — discrete + remaining
    // continuous)**: BINOM.DIST / BINOM.DIST.RANGE / BINOM.INV /
    // NEGBINOM.DIST / POISSON.DIST / EXPON.DIST / LOGNORM.DIST /
    // LOGNORM.INV. Scalar tier. statrs::Binomial / NegativeBinomial /
    // Poisson / LogNormal backing; EXPON.DIST closed-form (no
    // statrs). First discrete-distribution batch. BINOM.DIST.RANGE is
    // variadic (3 or 4 args).
    r.register("BINOM.DIST", distribution_fns::binom_dist);
    r.register("BINOM.DIST.RANGE", distribution_fns::binom_dist_range);
    r.register("BINOM.INV", distribution_fns::binom_inv);
    r.register("NEGBINOM.DIST", distribution_fns::negbinom_dist);
    r.register("POISSON.DIST", distribution_fns::poisson_dist);
    r.register("EXPON.DIST", distribution_fns::expon_dist);
    r.register("LOGNORM.DIST", distribution_fns::lognorm_dist);
    r.register("LOGNORM.INV", distribution_fns::lognorm_inv);

    // **W5-D-5 (Wave 3 distributions batch — CLOSES WAVE 3): gamma
    // family + beta + confidence intervals.** GAMMA / GAMMA.DIST /
    // GAMMA.INV / GAMMALN / GAMMALN.PRECISE / BETA.DIST / BETA.INV /
    // CONFIDENCE.NORM / CONFIDENCE.T. Scalar tier. statrs::Gamma /
    // statrs::Beta backing for distributions; closed-form via
    // statrs::function::gamma::{gamma, ln_gamma} for the gamma
    // functions; CONFIDENCE.* reuses standard_normal() (W5-D-1) +
    // students_t_with (W5-D-2). BETA.DIST/INV are variadic (4-6 /
    // 3-5 args).
    r.register("GAMMA", distribution_fns::gamma_fn_excel);
    r.register("GAMMA.DIST", distribution_fns::gamma_dist);
    r.register("GAMMA.INV", distribution_fns::gamma_inv);
    r.register("GAMMALN", distribution_fns::gamma_ln);
    r.register("GAMMALN.PRECISE", distribution_fns::gamma_ln_precise);
    r.register("BETA.DIST", distribution_fns::beta_dist);
    r.register("BETA.INV", distribution_fns::beta_inv);
    r.register("CONFIDENCE.NORM", distribution_fns::confidence_norm);
    r.register("CONFIDENCE.T", distribution_fns::confidence_t);

    // **6.4-0 substrate (2026-05-28):** populate first-class metadata
    // for every built-in dispatched above. Volatility + dep-shape come
    // from the two prior whitelists in `ql-exec::calcgraph_session`
    // (`is_volatile_function` `:149-164`, `is_address_only_reference_fn`
    // `:201-203`); the rest default to `Pure + ValueDeps + Scalar`. The
    // pass also debug-asserts every dispatch key has a matching metadata
    // entry — drift surfaces loud at test time.
    register_builtin_metadata(&mut r);

    r
}

/// **6.4-0 substrate (2026-05-28):** the builtin-metadata population
/// pass invoked at the tail of [`default_registry`]. Two phases:
///
/// 1. **Explicit overrides** for the small set of names whose volatility
///    / dep-shape diverges from the `Pure + ValueDeps` default. These
///    mirror the prior whitelists in `ql-exec::calcgraph_session`
///    (`is_volatile_function` for NOW/TODAY/RAND/.../INDIRECT/OFFSET/
///    INFO/CELL; `is_address_only_reference_fn` for ROW/COLUMN/ROWS/
///    COLUMNS/ISREF) so today's behavior carries over byte-for-byte.
///    INDIRECT/OFFSET/INFO/CELL are tagged `Volatility::Dynamic` rather
///    than `Volatile` (their result depends on workbook structure, not
///    on recalc cadence — closer to the DTO's variant rationale at
///    `crates/ql-session/src/function_meta.rs:40-43`). The engine's
///    `is_volatile_function` migration shim treats both `Volatile` and
///    `Dynamic` as "include in the volatile-pass set" to preserve today's
///    over-conservative-but-correct re-eval; 6.4 may refine.
///
/// 2. **Defaults** for every other dispatched function — `Pure +
///    ValueDeps + Scalar + Coercing + Cooperative`. Built off the
///    iteration of `r.fns.keys()` so adding a new built-in
///    auto-acquires metadata with no parallel-list maintenance burden.
///    Arity is left as `Variadic` for v1 (we don't track per-function
///    arity in the dispatch tables today; 6.4 may carry richer metadata
///    on `RegisteredFn` directly).
///
/// The two passes are **idempotent** — phase 2 inserts only when the
/// name isn't already in `metadata` (so the phase-1 overrides win).
fn register_builtin_metadata(r: &mut FunctionRegistry) {
    /// Construct the standard "pure scalar built-in" metadata for `name`
    /// — used as the default and as the base for the small set of
    /// overrides. Centralized so adding a new field to `FunctionMetadata`
    /// only touches one site.
    fn pure_scalar(name: &str) -> FunctionMetadata {
        FunctionMetadata {
            canonical_name: name.to_string(),
            display_name: None,
            aliases: Vec::new(),
            arity: Arity::Variadic,
            volatility: Volatility::Pure,
            determinism: true,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::Scalar,
            arg_policy: ArgPolicy::Coercing,
            cancellation: CancelPolicy::Cooperative,
            // **6.4-1 (2026-05-28; H1):** the conservative default. The
            // binder rejects range args under `BindContext::Scalar`, so any
            // pure-scalar built-in (ABS / SQRT / IF / …) and any unknown
            // function lands here. Phase 1.5 below explicitly overrides
            // the ~66 aggregate / range-aware / array-tier names; Phase 1
            // explicitly sets the 7 reference-aware names.
            arg_context: ArgContext::Scalar,
            provenance_tags: Vec::new(),
        }
    }

    // ---- Phase 1: explicit overrides for the prior whitelists ----------
    //
    // Time / pseudo-random — recompute every recalc (Volatility::Volatile
    // is the natural fit). `NOW`/`TODAY` are ContextAware in the dispatch
    // tier but their VOLATILITY (axis) is independent of their dispatch
    // ABI; both are still graph-volatile.
    for name in ["NOW", "TODAY", "RAND", "RANDBETWEEN", "RANDARRAY"] {
        let mut m = pure_scalar(name);
        m.volatility = Volatility::Volatile;
        m.determinism = false;
        // `register_metadata` enforces canonical-uppercase + dup loud;
        // we built the metadata above so insertion can't conflict here
        // unless someone added a duplicate to the override list.
        r.register_metadata(m)
            .expect("phase-1 volatile override must not collide with prior phase-1 entry");
    }
    // Address-by-string / structural / environment introspection —
    // result depends on workbook structure, not just args. Tagged
    // `Dynamic` (per DTO variant rationale); the migration shim in
    // `calcgraph_session::is_volatile_function` treats Dynamic as
    // "include in the volatile-pass set" so today's behavior carries.
    for name in ["INDIRECT", "OFFSET", "INFO", "CELL"] {
        let mut m = pure_scalar(name);
        m.volatility = Volatility::Dynamic;
        m.determinism = false;
        r.register_metadata(m)
            .expect("phase-1 dynamic override must not collide with prior phase-1 entry");
    }
    // **Wave P (2026-06-20):** LET / LAMBDA are binder-recognized SPECIAL FORMS
    // (not dispatch-tier functions), so they have NO `RegisteredFn` entry — but
    // they MUST appear in the IDE function catalog (fed by `sorted_metadata`).
    // Register metadata-only entries: Pure + Variadic + Scalar arg-context (the
    // `pure_scalar` default — arg_context is moot since the binder special-cases
    // them before consulting it; a LET/LAMBDA formula's actual volatility comes
    // from `walk_plan_for_deps` descending its body, NOT this name's metadata).
    // They are intentionally absent from `fns`, so the function COUNT and
    // `coverage.rs` (which iterate `fns` / `names_all`) are unaffected, and the
    // boot "every dispatch key has metadata" invariant still holds (it is a
    // subset, not a bijection — metadata-only entries are explicitly allowed).
    for name in ["LET", "LAMBDA"] {
        r.register_metadata(pure_scalar(name))
            .expect("Wave P LET/LAMBDA metadata-only entry must not collide");
    }
    // Address-only reference fns: ROW / COLUMN / ROWS / COLUMNS. The
    // walker `walk_plan_for_address_only_deps` routes their args away
    // from value-deps.
    //
    // **6.4-1 (2026-05-28; H1):** all four also gain `ArgContext::Reference`
    // so `ql-exec::plan`'s `is_reference_aware_function` derives from
    // metadata. The binder routes their args under `BindContext::ReferenceArg`
    // (accepts literal CellRef / RangeRef / NameRef).
    for name in ["ROW", "COLUMN", "ROWS", "COLUMNS"] {
        let mut m = pure_scalar(name);
        m.dep_shape = DepShape::AddressOnly;
        m.arg_context = ArgContext::Reference;
        r.register_metadata(m)
            .expect("phase-1 address-only override must not collide with prior phase-1 entry");
    }

    // **6.4-1 (2026-05-28; I1):** ISREF gets `DepShape::LazyShape` (not
    // `AddressOnly`). LazyShape semantics: the walker never recurses,
    // never registers value-deps, never propagates volatility — `ISREF(NOW())`
    // does NOT mark the formula volatile; `ISREF(A1+1)` does NOT register
    // A1's dep. Pre-6.4-1 this was a hardcoded `name == "ISREF"` short-
    // circuit in the walker's `Function` arm; the I1 closure moves the
    // decision to metadata so 6.4 UDFs declaring `dep_shape: LazyShape`
    // get the same treatment without engine-side name special-casing.
    //
    // **6.4-1 cycle-2 audit-fix L1 (2026-05-28; doc correction):** the
    // engine has TWO DISJOINT migration shims after I1:
    // (1) `is_address_only_reference_fn(registry, name)` matches ONLY
    //     `Some(DepShape::AddressOnly)` and returns `true` for ROW /
    //     COLUMN / ROWS / COLUMNS, `false` for ISREF.
    // (2) `is_lazy_shape_reference_fn(registry, name)` matches ONLY
    //     `Some(DepShape::LazyShape)` and returns `true` for ISREF,
    //     `false` for the four address-only names.
    // The walker checks `is_lazy_shape_reference_fn` FIRST in the
    // `ExprPlan::Function` arm (the LazyShape skip-all-arg-walking branch
    // is the strictest, so it gets priority); then falls through to
    // `is_address_only_reference_fn` for the eager-with-shape-aware-walk
    // branch; then the normal `walk_plan_for_deps`. The two shims do NOT
    // overlap — `arg_context: Reference` is the axis they share.
    {
        let mut m = pure_scalar("ISREF");
        m.dep_shape = DepShape::LazyShape;
        m.arg_context = ArgContext::Reference;
        r.register_metadata(m)
            .expect("phase-1 ISREF override must not collide with prior phase-1 entry");
    }

    // **6.4-1 (2026-05-28; H1):** the remaining two reference-aware
    // names — ISFORMULA and FORMULATEXT — that the binder admits under
    // `BindContext::ReferenceArg` but whose walker treats with normal
    // `ValueDeps` semantics (Eager + workbook query — design § 8 R8). They
    // need `ArgContext::Reference` from metadata; their `DepShape` stays
    // `ValueDeps` (the `pure_scalar` default).
    for name in ["ISFORMULA", "FORMULATEXT"] {
        let mut m = pure_scalar(name);
        m.arg_context = ArgContext::Reference;
        r.register_metadata(m)
            .expect("phase-1 reference-arg override must not collide with prior phase-1 entry");
    }

    // ---- Phase 1.5: ArgContext::Aggregate overrides (H1 source) -----------
    //
    // **6.4-1 (2026-05-28; H1):** the binder-admission category for the
    // names that pre-6.4-1 lived as the ~66-entry `matches!` whitelist in
    // `ql-exec::plan::is_aggregate_function`. These names accept range
    // args (named ranges, literal ranges in some tiers, range-aware
    // dispatch) — the binder must route them under
    // `BindContext::AggregateArg` rather than `BindContext::Scalar` so
    // `=SUM(SalesRange)` etc. bind correctly. The list is mirrored from
    // the pre-6.4-1 source at `plan.rs:422-536`. Adding a name here is
    // equivalent to adding it to the pre-6.4-1 `matches!` list — the
    // `plan.rs::is_aggregate_function` shim now reads
    // `metadata.arg_context == ArgContext::Aggregate`.
    //
    // The list straddles three dispatch tiers (scalar aggregates,
    // range-aware, unified array) — `ArgContext` is orthogonal to the
    // dispatch tier and to `BatchShape` (builtin aggregates remain
    // `BatchShape::Scalar` because their eval ABI is `fn(&[Value]) -> Value`
    // per cell after the named-range cache hit; UDFs declaring
    // `BatchShape::ArrayBatch` register their own `ArgContext::Aggregate`).
    for name in [
        // Scalar aggregates (W4-4, W5-58 stats family extras).
        "SUM",
        "AVERAGE",
        "AVG",
        "COUNT",
        "COUNTA",
        "MIN",
        "MAX",
        "PRODUCT",
        "VAR",
        "VAR.S",
        "VAR.P",
        "STDEV",
        "STDEV.S",
        "STDEV.P",
        // Range-aware conditional aggregates (W5-53).
        "SUMIF",
        "COUNTIF",
        // Range-aware lookup family (W5-54).
        "MATCH",
        "INDEX",
        "VLOOKUP",
        "HLOOKUP",
        "CHOOSE",
        // Range-aware conditional-aggregate completion (W5-55).
        "AVERAGEIF",
        "SUMIFS",
        "COUNTIFS",
        "AVERAGEIFS",
        "SUMPRODUCT",
        // Range-aware stats family (W5-58).
        "LARGE",
        "SMALL",
        "RANK",
        "RANK.EQ",
        "RANK.AVG",
        "MEDIAN",
        "MODE",
        "MODE.SNGL",
        // Range-aware text completion (W5-61 polish).
        "CONCAT",
        // Unified-ABI array-returning fns (W5-107 / Phase 4.7.N).
        "TRANSPOSE",
        "FILTER",
        // Range-aware conditional-aggregate dispatcher (W5-D-12).
        "SUBTOTAL",
        // Phase 4.10 statistical paired-array fns (W5-177, W5-178,
        // W5-179, W5-D-6).
        "CORREL",
        "PEARSON",
        "RSQ",
        "STEYX",
        "SLOPE",
        "INTERCEPT",
        "COVARIANCE.P",
        "COVARIANCE.S",
        "SUMX2MY2",
        "SUMX2PY2",
        "SUMXMY2",
        // Phase 4.10 financial cash-flow fns (W5-168, W5-174, W5-D-7).
        "NPV",
        "IRR",
        "MIRR",
        "XNPV",
        "XIRR",
        // Phase 4.10 modern lookup fns (W5-169).
        "XLOOKUP",
        "XMATCH",
        // Phase 4.10 order-statistics fns (W5-D-11).
        "PERCENTILE.INC",
        "PERCENTILE.EXC",
        "PERCENTILE",
        "QUARTILE.INC",
        "QUARTILE.EXC",
        "QUARTILE",
        // Phase 4.10 conditional aggregates / text join (W5-164, W5-167).
        "MINIFS",
        "MAXIFS",
        "COUNTBLANK",
        "TEXTJOIN",
        // B2 (native quant fns) — range-aware quant aggregates. NOT part of
        // the pre-6.4-1 byte-for-byte whitelist (they postdate it); the
        // dedicated `b2_quant_fns_admitted_to_is_aggregate_function` test and
        // the `validate.rs` invariants pin them. Without these names the
        // binder hands them an implicitly-intersected scalar instead of the
        // range, silently breaking `=SHARPE(A1:A10)` / `=SORTINO(A1:A10)`.
        // (Wave A added VOLATILITY + SORTINO; both also pinned in the
        // `post_6_4_1_aggregate_additions` allowlist below.)
        "SHARPE",
        "MAX_DRAWDOWN",
        "VOLATILITY",
        "SORTINO",
    ] {
        // Some of these names overlap Phase-1 overrides (none currently —
        // Phase 1 covers NOW/TODAY/RAND/RANDBETWEEN/RANDARRAY +
        // INDIRECT/OFFSET/INFO/CELL + ROW/COLUMN/ROWS/COLUMNS/ISREF +
        // ISFORMULA/FORMULATEXT, none of which appear above), but if a
        // future Phase-1 entry ALSO needs `ArgContext::Aggregate` the
        // override path is to merge there (set `m.arg_context =
        // Aggregate` after the volatility/dep-shape fields).
        //
        // For now this pass is self-contained: insert directly if absent,
        // patch arg_context if already present from a prior pass.
        if let Some(existing) = r.metadata.get_mut(name) {
            existing.arg_context = ArgContext::Aggregate;
        } else {
            let mut m = pure_scalar(name);
            m.arg_context = ArgContext::Aggregate;
            r.register_metadata(m).expect(
                "phase-1.5 aggregate override must not collide with prior \
                 phase-1 or phase-1.5 entry",
            );
        }
    }

    // ---- Phase 2: defaults for every other dispatched built-in ----------
    let names: Vec<&'static str> = r.fns.keys().copied().collect();
    for name in names {
        if !r.metadata.contains_key(name) {
            // Phase-1 didn't set this one; insert the Pure+ValueDeps default
            // directly into the map (skip the public API's canonical-case
            // assert — every `fns` key is already canonical per
            // `insert_or_panic`'s precondition assert).
            r.metadata.insert(name.to_string(), pure_scalar(name));
        }
    }

    // ---- Invariant: every dispatch key now has metadata -----------------
    //
    // Tightens the "migration shim" discipline in contract §10.2 — a
    // future built-in that registers via `r.register*(…)` but bypasses
    // this pass would be invisible to the metadata table and silently
    // fall back to "unknown function" semantics at the walker, breaking
    // the contract's "built-ins register their true metadata" promise.
    //
    // **Subset invariant (NOT bijection):** the metadata table may carry
    // extra entries that have no dispatch counterpart — Phase 1 above
    // explicitly tags INDIRECT/OFFSET/INFO/CELL as Dynamic so the dep
    // walker treats them as graph-volatile EVEN THOUGH they aren't yet
    // dispatchable (the registry comment at `:647-648` defers their
    // implementation to a future Phase 4.3 wave). (RANDARRAY was in this
    // set until Wave O — 2026-06-20 — shipped its dispatch; it now has
    // BOTH metadata and a dispatch entry.) The contract §10.3
    // unknown-function policy is "graph-visible and treated
    // Volatile/Dynamic"; encoding that here keeps a user-typed
    // `=INDIRECT(...)` flagged volatile even before dispatch
    // ships, matching today's `is_volatile_function` whitelist behavior.
    //
    // **6.4-0 audit-fix (2026-05-28; Opus L2):** upgraded from
    // `debug_assert!` to `assert!` — a release build that hits this
    // failure now panics at registry construction (boot time) rather
    // than silently shipping with broken walker invariants. Cost is
    // one O(n) walk at boot (n=260; ~µs); the alternative is that a
    // future contributor adding a `r.register*` call without a
    // matching metadata entry ships a release binary with silent
    // unknown-fn fallback for that built-in. The boot-time fail-loud
    // matches the No-Fallbacks rule.
    assert!(
        r.fns.keys().all(|name| r.metadata.contains_key(*name)),
        "FunctionRegistry: every dispatched built-in must have metadata; \
         a `r.register*` call without a matching metadata override here \
         would silently fall back to unknown-fn semantics in the dep walker. \
         dispatch={} metadata={}.",
        r.fns.len(),
        r.metadata.len(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_registry_lookup_none() {
        let r = FunctionRegistry::new();
        assert!(r.is_empty());
        assert!(r.lookup("SUM").is_none());
    }

    #[test]
    fn default_registry_has_expected_count() {
        let r = default_registry();
        // 61 entries — Phase 0 W4-4 (22 functions + 3 aliases = 25) +
        // AI sentinel (1) + Phase 3.7 volatiles (NOW/TODAY/RAND/
        // RANDBETWEEN = 4) + Phase 4.3 V1 wave 1 (ROUNDUP, ROUNDDOWN,
        // TRUNC, SIGN, EXP, LN, LOG, LOG10, PI, DEGREES, RADIANS, LEN,
        // UPPER, LOWER, TRIM, ISNUMBER, ISTEXT, ISBLANK, ISLOGICAL,
        // ISERROR, ISNA, ISERR = 22) + Phase 4.3 V2 trig (W5-51:
        // SIN, COS, TAN, ASIN, ACOS, ATAN, ATAN2 = 7) + Phase 4.3 V2
        // range-aware (W5-53: SUMIF, COUNTIF = 2) + Phase 4.3 V2
        // lookup family (W5-54: MATCH, INDEX, VLOOKUP, HLOOKUP,
        // CHOOSE = 5) + Phase 4.3 V2 conditional-aggregate
        // completion (W5-55: AVERAGEIF, SUMIFS, COUNTIFS, AVERAGEIFS,
        // SUMPRODUCT = 5) + Phase 4.3 V2 text wave 2 (W5-56: LEFT,
        // RIGHT, MID, FIND, SEARCH, SUBSTITUTE, REPLACE, CONCATENATE,
        // REPT, EXACT = 10) + Phase 4.3 V2 math completion +
        // hyperbolic trig (W5-57: CEILING, FLOOR, MROUND, ODD,
        // EVEN, QUOTIENT, GCD, LCM, SINH, COSH, TANH, ASINH,
        // ACOSH, ATANH = 14) + Phase 4.3 V2 stats family (W5-58:
        // LARGE, SMALL, RANK, RANK.EQ alias, MEDIAN, MODE,
        // MODE.SNGL alias = 7) + Phase 4.3 polish wave 1 (W5-61:
        // PROPER, CLEAN, CEILING.MATH, FLOOR.MATH, RANK.AVG,
        // CONCAT = 6) + Phase 4.5.B wave 1 (W5-72: DATE, YEAR,
        // MONTH, DAY, HOUR, MINUTE, SECOND, TIME = 8) + Phase 4.5.B
        // wave 2 (W5-73: DATEVALUE, TIMEVALUE, WEEKDAY, EOMONTH,
        // EDATE = 5) + Phase 4.5.B wave 3 (W5-74: DAYS, NETWORKDAYS,
        // WORKDAY, YEARFRAC = 4 — CLOSES V1 wave 18/18) + Phase 4.5.C
        // V2 wave (W5-75: DATEDIF, DAYS360, WEEKNUM, ISOWEEKNUM = 4
        // of 6; NETWORKDAYS.INTL + WORKDAY.INTL deferred to tier-4) +
        // Phase 4.5.E (W5-83: TEXT = 1) +
        // Phase 4.7.M (W5-106: SEQUENCE = 1, first array-returning fn) +
        // Phase 4.7.N (W5-107: TRANSPOSE + FILTER = 2, second + third
        // array-returning fns) +
        // Phase 4.10.A (W5-163: IFS, IFNA, XOR, SWITCH = 4 logical
        // fillins; first batch of Function Library Wave 2) +
        // Phase 4.10.B (W5-164: MINIFS, MAXIFS, COUNTBLANK = 3
        // conditional-aggregate fillins) +
        // Phase 4.10.C (W5-165: AVERAGEA, MAXA, MINA = 3 *A-variants
        // + NA, ERROR.TYPE, TYPE, ISEVEN, ISODD, ISNONTEXT, N = 7
        // info scalars = 10 total) +
        // Phase 4.10.D (W5-166: FACT, FACTDOUBLE, COMBIN, COMBINA,
        // PERMUT, PERMUTATIONA, SUMSQ = 7 scalar combinatorics +
        // SUMX2MY2, SUMX2PY2, SUMXMY2 = 3 range-aware paired-array
        // sum-of-squares = 10 total) +
        // Phase 4.10.E (W5-167: CHAR, CODE, UNICODE, UNICHAR = 4
        // scalar codepoint round-trip + VALUE, FIXED, DOLLAR = 3
        // locale-aware context-aware + TEXTJOIN = 1 range-aware
        // variadic join = 8 total) +
        // Phase 4.10.F (W5-168: PMT, FV, PV, NPER, RATE, IPMT, PPMT
        // = 7 TVM scalars + NPV, IRR = 2 cash-flow range-aware = 9
        // total) +
        // Phase 4.10.G (W5-169: XLOOKUP, XMATCH = 2 modern lookups +
        // ADDRESS = 1 scalar text formatter = 3 total; CLOSES Wave 2) +
        // Phase 4.10 polish (W5-173: NUMBERVALUE = 1 locale-explicit
        // text-to-number variant of VALUE; W5-174: MIRR = 1 closed-form
        // Modified IRR; W5-177: CORREL = 1 Pearson correlation
        // coefficient; W5-178: SLOPE + INTERCEPT = 2 least-squares
        // regression; W5-179: PEARSON + RSQ + STEYX = 3 — CLOSES the
        // Wave 3 regression batch; W5-180: SLN + SYD = 2 — Wave 3
        // depreciation batch starter; W5-181: DDB = 1 — closed-form
        // double-declining-balance; W5-182: DB = 1 — period-iterating
        // fixed-declining-balance; W5-183: VDB = 1 — CLOSES Wave 3
        // depreciation batch) +
        // W5-RT-2 (RT-V1-01 Step 2): ROW, COLUMN, ROWS, COLUMNS = 4
        // — reference-tier address-only batch; first fns through the
        // new ReferenceAware tier (W5-RT-1) +
        // W5-RT-3 (RT-V1-01 Step 3): ISREF + ISFORMULA = 2
        // — reference-tier information batch; ISREF uses LazyShape
        // (first user-facing fn through that contract), ISFORMULA
        // uses Eager + workbook ReferenceQuery::is_formula_at +
        // W5-RT-4 (RT-V1-01 Step 4 — CLOSES the reference-tier mini-phase):
        // FORMULATEXT = 1 — reference-tier text batch; Eager +
        // ReferenceQuery::formula_text_at (prepends leading `=`) +
        // W5-D-1 (Wave 3 distributions batch — normal): NORM.DIST,
        // NORM.S.DIST, NORM.INV, NORM.S.INV = 4 — scalar tier; statrs
        // backing matching IronCalc's behavior (both pin statrs 0.18.0) +
        // W5-D-2 (Wave 3 distributions batch — Student's t): T.DIST,
        // T.DIST.2T, T.DIST.RT, T.INV, T.INV.2T = 5 — scalar tier;
        // statrs::StudentsT backing +
        // W5-D-3 (Wave 3 distributions batch — chi-squared + F):
        // CHISQ.DIST, CHISQ.DIST.RT, CHISQ.INV, CHISQ.INV.RT, F.DIST,
        // F.DIST.RT, F.INV, F.INV.RT = 8 — scalar tier;
        // statrs::ChiSquared + statrs::FisherSnedecor backing +
        // W5-D-4 (Wave 3 distributions batch — discrete + remaining
        // continuous): BINOM.DIST, BINOM.DIST.RANGE, BINOM.INV,
        // NEGBINOM.DIST, POISSON.DIST, EXPON.DIST, LOGNORM.DIST,
        // LOGNORM.INV = 8 — scalar tier; statrs Binomial /
        // NegativeBinomial / Poisson / LogNormal + closed-form
        // EXPON.DIST. First discrete-distribution batch +
        // W5-D-5 (Wave 3 distributions batch — CLOSES WAVE 3
        // distributions): GAMMA, GAMMA.DIST, GAMMA.INV, GAMMALN,
        // GAMMALN.PRECISE, BETA.DIST, BETA.INV, CONFIDENCE.NORM,
        // CONFIDENCE.T = 9 — scalar tier; statrs Gamma/Beta +
        // statrs::function::gamma + CONFIDENCE.* reusing W5-D-1/W5-D-2
        // helpers.
        // W5-D-6 (Wave 3 closure — paired-array statistics):
        // COVARIANCE.P, COVARIANCE.S = 2 — range-aware tier;
        // population vs sample covariance via shared compute_covariance
        // kernel. Closes the Wave 3 paired-array gap.
        // W5-D-7 (Wave 3 closure — CLOSES WAVE 3 — date-indexed
        // cash flow): XNPV, XIRR = 2 — range-aware tier; XNPV
        // closed-form, XIRR Newton-Raphson with bisection fallback
        // (matches IronCalc's `compute_xirr` pattern). Closes the
        // final Wave-3-tagged matrix item.
        // W5-D-8 (Phase 4.10 — V1 260 closeout — engineering bit
        // ops): BITAND, BITOR, BITXOR, BITLSHIFT, BITRSHIFT = 5 —
        // scalar tier; Excel canon `[0, 2^48-1]` domain + `|shift|
        // <= 53`. First V1-260-closeout batch after Wave 3.
        // W5-D-9 (Phase 4.10 — V1 260 closeout — base conversion):
        // DEC2BIN, DEC2OCT, DEC2HEX, BIN2DEC, OCT2DEC, HEX2DEC = 6 —
        // scalar tier; 10-digit two's-complement canon per base.
        // W5-D-10 (Phase 4.10 — V1 260 closeout — error function
        // family): ERF, ERF.PRECISE, ERFC, ERFC.PRECISE = 4 —
        // scalar tier; closed-form via statrs::function::erf.
        // W5-D-11 (Phase 4.10 — V1 260 closeout — order statistics):
        // PERCENTILE.INC, PERCENTILE.EXC, PERCENTILE (legacy alias of
        // .INC), QUARTILE.INC, QUARTILE.EXC, QUARTILE (legacy alias of
        // .INC) = 6 — range-aware tier; array sort + linear interpolation.
        // IronCalc does NOT ship these; original port against Microsoft.
        // W5-D-12 (Phase 4.10 — V1 260 sealer): SUBTOTAL = 1 — range-
        // aware conditional aggregate dispatcher (function_num 1..=11
        // and 101..=111). v1 normalizes 101..=111 to 1..=11 (no hidden-
        // row metadata in engine). **CLOSES Phase 4.10 V1-260 at 260.**
        // B2 (native quant fns, post-V1-260): SHARPE, MAX_DRAWDOWN = 2 —
        // range-aware tier; built on the welford stddev/mean primitives.
        // SHARPE = mean(excess returns)/sample-stdev with optional
        // sqrt(periods) annualization; MAX_DRAWDOWN = max peak-to-trough
        // decline of an equity/price series (negative fraction). => 262.
        // B2 Wave A: VOLATILITY (sample-stdev of returns, optional sqrt(periods);
        // constant series => 0.0) + SORTINO ((mean-MAR)/downside-deviation,
        // empyrical all-N convention, sqrt(periods) annualization) = 2. => 264.
        // Wave O (2026-06-20 — dynamic-array completion): SORT, SORTBY, UNIQUE,
        // RANDARRAY = 4 — unified array-returning tier (RANDARRAY was previously
        // metadata-only/volatile; its dispatch ships here). => 268.
        assert_eq!(r.len(), 268);
    }

    #[test]
    fn range_aware_lookup_returns_registered_function() {
        let r = default_registry();
        assert!(r.lookup_range_aware("SUMIF").is_some());
        assert!(r.lookup_range_aware("sumif").is_some()); // case-insensitive
        assert!(r.lookup_range_aware("COUNTIF").is_some());
        // SUM is NOT range-aware (uses the existing ScalarFn path).
        assert!(r.lookup_range_aware("SUM").is_none());
    }

    #[test]
    fn scalar_and_range_aware_tiers_are_disjoint() {
        // W5-96: tier disjointness is now structurally enforced by the
        // unified HashMap (one name → one RegisteredFn). The test still
        // verifies that no name resolves through BOTH filter views.
        let r = default_registry();
        for name in r.names() {
            assert!(
                r.lookup_range_aware(name).is_none(),
                "name {name:?} resolves as both Scalar and RangeAware"
            );
        }
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn register_range_aware_with_existing_scalar_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register("FOO", scalar_fns::sum);
        r.register_range_aware("FOO", range_fns::sumif);
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn duplicate_range_aware_registration_panics() {
        let mut r = FunctionRegistry::new();
        r.register_range_aware("SUMIF", range_fns::sumif);
        r.register_range_aware("SUMIF", range_fns::sumif);
    }

    // ===== W5-69 Phase 4.5.A.0 — context-aware tier =====

    // A trivial test fixture: a context-aware fn that returns the
    // workbook's date-system as a Number (1900→1900.0, 1904→1904.0).
    // Lets us verify dispatch + arg-shape without depending on any
    // not-yet-implemented date function.
    fn echo_date_system_year(args: &[Value], ctx: &ql_types::EvalContext) -> Value {
        if !args.is_empty() {
            return Value::Error(ql_types::ErrorValue::Value);
        }
        let n = match ctx.date_system {
            ql_types::DateSystem::Excel1900 => 1900.0,
            ql_types::DateSystem::Excel1904 => 1904.0,
        };
        Value::Number(n)
    }

    #[test]
    fn context_aware_register_and_lookup_works() {
        let mut r = FunctionRegistry::new();
        r.register_context_aware("ECHO.DS", echo_date_system_year);
        assert!(r.lookup_context_aware("ECHO.DS").is_some());
        assert!(r.lookup_context_aware("echo.ds").is_some()); // case-insensitive
        assert!(r.lookup("ECHO.DS").is_none()); // NOT in scalar table
        assert!(r.lookup_range_aware("ECHO.DS").is_none()); // NOT in range-aware table
    }

    #[test]
    fn context_aware_fn_receives_eval_context() {
        let mut r = FunctionRegistry::new();
        r.register_context_aware("ECHO.DS", echo_date_system_year);
        let f = r.lookup_context_aware("ECHO.DS").expect("registered");
        let ctx_1900 = ql_types::EvalContext::default();
        assert_eq!(f(&[], &ctx_1900), Value::Number(1900.0));
        let ctx_1904 = ql_types::EvalContext {
            date_system: ql_types::DateSystem::Excel1904,
            ..ql_types::EvalContext::default()
        };
        assert_eq!(f(&[], &ctx_1904), Value::Number(1904.0));
    }

    #[test]
    fn context_aware_tier_disjoint_from_scalar() {
        // W5-96: structurally enforced by the unified HashMap.
        let r = default_registry();
        for name in r.names() {
            assert!(
                r.lookup_context_aware(name).is_none(),
                "{name:?} resolves as both Scalar and ContextAware"
            );
        }
    }

    #[test]
    fn context_aware_tier_disjoint_from_range_aware() {
        let r = default_registry();
        for name in r.range_aware_names() {
            assert!(
                r.lookup_context_aware(name).is_none(),
                "{name:?} resolves as both RangeAware and ContextAware"
            );
        }
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn register_context_aware_with_existing_scalar_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register("FOO", scalar_fns::sum);
        r.register_context_aware("FOO", echo_date_system_year);
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn register_context_aware_with_existing_range_aware_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register_range_aware("FOO", range_fns::sumif);
        r.register_context_aware("FOO", echo_date_system_year);
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn register_scalar_with_existing_context_aware_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register_context_aware("FOO", echo_date_system_year);
        r.register("FOO", scalar_fns::sum);
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn register_range_aware_with_existing_context_aware_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register_context_aware("FOO", echo_date_system_year);
        r.register_range_aware("FOO", range_fns::sumif);
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn duplicate_context_aware_registration_panics() {
        let mut r = FunctionRegistry::new();
        r.register_context_aware("ECHO.DS", echo_date_system_year);
        r.register_context_aware("ECHO.DS", echo_date_system_year);
    }

    #[test]
    fn names_all_chains_all_three_tables() {
        let mut r = FunctionRegistry::new();
        r.register("SCALAR_FN", scalar_fns::sum);
        r.register_range_aware("RANGE_FN", range_fns::sumif);
        r.register_context_aware("CONTEXT_FN", echo_date_system_year);
        let all: Vec<&str> = r.names_all().copied().collect();
        assert!(all.contains(&"SCALAR_FN"));
        assert!(all.contains(&"RANGE_FN"));
        assert!(all.contains(&"CONTEXT_FN"));
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn len_includes_context_aware_table() {
        let mut r = FunctionRegistry::new();
        r.register("S", scalar_fns::sum);
        assert_eq!(r.len(), 1);
        r.register_range_aware("RA", range_fns::sumif);
        assert_eq!(r.len(), 2);
        r.register_context_aware("CA", echo_date_system_year);
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn is_empty_checks_all_three_tables() {
        let mut r = FunctionRegistry::new();
        assert!(r.is_empty());
        r.register_context_aware("CA", echo_date_system_year);
        assert!(!r.is_empty());
    }

    #[test]
    fn context_aware_names_returns_only_context_aware() {
        let mut r = FunctionRegistry::new();
        r.register("S", scalar_fns::sum);
        r.register_range_aware("RA", range_fns::sumif);
        r.register_context_aware("CA", echo_date_system_year);
        let names: Vec<&str> = r.context_aware_names().copied().collect();
        assert_eq!(names, vec!["CA"]);
    }

    #[test]
    fn ai_dispatches_to_not_available_sentinel() {
        use ql_types::ErrorValue;
        let r = default_registry();
        let ai = r.lookup("AI").expect("AI is registered");
        // AI ignores its args and returns the AINotAvailable error.
        assert_eq!(ai(&[]), Value::Error(ErrorValue::AINotAvailable));
        assert_eq!(
            ai(&[Value::Number(1.0), Value::text("prompt")]),
            Value::Error(ErrorValue::AINotAvailable)
        );
        // Case-insensitive lookup works.
        let ai_lower = r.lookup("ai").expect("ai (lowercase) resolves");
        assert_eq!(ai_lower(&[]), Value::Error(ErrorValue::AINotAvailable));
    }

    #[test]
    fn lookup_is_case_insensitive() {
        let r = default_registry();
        let sum_upper = r.lookup("SUM").unwrap();
        let sum_lower = r.lookup("sum").unwrap();
        let sum_mixed = r.lookup("Sum").unwrap();
        let result_upper = sum_upper(&[Value::Number(1.0), Value::Number(2.0)]);
        let result_lower = sum_lower(&[Value::Number(1.0), Value::Number(2.0)]);
        let result_mixed = sum_mixed(&[Value::Number(1.0), Value::Number(2.0)]);
        assert_eq!(result_upper, Value::Number(3.0));
        assert_eq!(result_lower, result_upper);
        assert_eq!(result_mixed, result_upper);
    }

    #[test]
    fn lookup_missing_returns_none() {
        let r = default_registry();
        assert!(r.lookup("FAKE_FN_NAME_XYZ").is_none());
    }

    #[test]
    fn dotted_function_names_supported() {
        // VAR.S — Excel uses dot in modern compatibility-friendly names.
        let r = default_registry();
        let var_s = r.lookup("VAR.S").unwrap();
        let result = var_s(&[Value::Number(1.0), Value::Number(3.0)]);
        assert_eq!(result, Value::Number(2.0));
    }

    // ===== Phase 2A.7 audit M5: register contract =====

    #[test]
    #[should_panic(expected = "canonical upper-case")]
    fn register_lowercase_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register("sum", scalar_fns::sum);
    }

    #[test]
    #[should_panic(expected = "canonical upper-case")]
    fn register_mixed_case_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register("Sum", scalar_fns::sum);
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn register_duplicate_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register("SUM", scalar_fns::sum);
        r.register("SUM", scalar_fns::sum);
    }

    #[test]
    #[should_panic(expected = "name must not be empty")]
    fn register_empty_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register("", scalar_fns::sum);
    }

    #[test]
    fn register_dotted_uppercase_name_ok() {
        // Dotted Excel-canonical names (VAR.S, STDEV.P) are upper-case.
        let mut r = FunctionRegistry::new();
        r.register("CUSTOM.FN", scalar_fns::sum);
        assert!(r.lookup("CUSTOM.FN").is_some());
        // Case-insensitive lookup still works.
        assert!(r.lookup("custom.fn").is_some());
    }

    #[test]
    fn aliases_dispatch_to_same_fn() {
        let r = default_registry();
        // VAR and VAR.S — both map to sample variance.
        let var = r.lookup("VAR").unwrap();
        let var_s = r.lookup("VAR.S").unwrap();
        let data = &[Value::Number(1.0), Value::Number(3.0)];
        assert_eq!(var(data), var_s(data));
    }

    #[test]
    fn end_to_end_sum_via_registry() {
        let r = default_registry();
        let sum = r.lookup("SUM").unwrap();
        let result = sum(&[
            Value::Number(10.0),
            Value::Number(20.0),
            Value::Number(30.0),
        ]);
        assert_eq!(result, Value::Number(60.0));
    }

    // ===== W5-96 (Phase 4.7.B) unified ABI =====

    /// Fixture: a unified-tier function that returns a fixed 1×3
    /// `ArrayValue` so we can verify the array-returning path
    /// end-to-end through `register_unified` + `lookup_unified`.
    fn fixed_sequence_3(_args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
        FunctionReturn::Array(ArrayValue::row(vec![
            Value::Number(1.0),
            Value::Number(2.0),
            Value::Number(3.0),
        ]))
    }

    /// Fixture: a unified-tier function that echoes its first arg.
    fn echo_first(args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
        match args.first() {
            Some(FunctionArg::Scalar(v)) => FunctionReturn::Scalar(v.clone()),
            Some(FunctionArg::Array(a)) => FunctionReturn::Array(a.clone()),
            _ => FunctionReturn::Scalar(Value::Error(ql_types::ErrorValue::Value)),
        }
    }

    #[test]
    fn register_unified_and_lookup_unified_round_trip() {
        let mut r = FunctionRegistry::new();
        r.register_unified("FIXED_SEQ", fixed_sequence_3);
        let f = r.lookup_unified("FIXED_SEQ").expect("registered");
        let ctx = ql_types::EvalContext::default();
        let fctx = FunctionContext::new(&ctx);
        let ret = f(&[], &fctx);
        match ret {
            FunctionReturn::Array(a) => {
                assert_eq!(a.rows(), 1);
                assert_eq!(a.cols(), 3);
            }
            FunctionReturn::Scalar(_) => panic!("expected array return"),
        }
    }

    #[test]
    fn lookup_unified_is_case_insensitive() {
        let mut r = FunctionRegistry::new();
        r.register_unified("FIXED_SEQ", fixed_sequence_3);
        assert!(r.lookup_unified("fixed_seq").is_some());
        assert!(r.lookup_unified("Fixed_Seq").is_some());
    }

    #[test]
    fn unified_tier_disjoint_from_other_tiers() {
        let mut r = FunctionRegistry::new();
        r.register_unified("UFN", fixed_sequence_3);
        // The legacy filter views must NOT return the unified fn.
        assert!(r.lookup("UFN").is_none());
        assert!(r.lookup_range_aware("UFN").is_none());
        assert!(r.lookup_context_aware("UFN").is_none());
        // But lookup_any does see it.
        assert!(matches!(
            r.lookup_any("UFN"),
            Some(RegisteredFn::Unified(_))
        ));
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn register_unified_with_existing_scalar_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register("FOO", scalar_fns::sum);
        r.register_unified("FOO", fixed_sequence_3);
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn register_scalar_with_existing_unified_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register_unified("FOO", fixed_sequence_3);
        r.register("FOO", scalar_fns::sum);
    }

    #[test]
    #[should_panic(expected = "duplicate registration")]
    fn duplicate_unified_registration_panics() {
        let mut r = FunctionRegistry::new();
        r.register_unified("UFN", fixed_sequence_3);
        r.register_unified("UFN", fixed_sequence_3);
    }

    #[test]
    fn unified_names_returns_only_unified() {
        let mut r = FunctionRegistry::new();
        r.register("S", scalar_fns::sum);
        r.register_range_aware("RA", range_fns::sumif);
        r.register_context_aware("CA", echo_date_system_year);
        r.register_unified("UFN", fixed_sequence_3);
        let names: Vec<&str> = r.unified_names().copied().collect();
        assert_eq!(names, vec!["UFN"]);
    }

    #[test]
    fn names_all_includes_unified() {
        let mut r = FunctionRegistry::new();
        r.register("S", scalar_fns::sum);
        r.register_range_aware("RA", range_fns::sumif);
        r.register_context_aware("CA", echo_date_system_year);
        r.register_unified("UFN", fixed_sequence_3);
        let all: std::collections::HashSet<&str> = r.names_all().copied().collect();
        assert!(all.contains("S"));
        assert!(all.contains("RA"));
        assert!(all.contains("CA"));
        assert!(all.contains("UFN"));
        assert_eq!(all.len(), 4);
        assert_eq!(r.len(), 4);
    }

    #[test]
    fn function_arg_array_round_trips_through_unified() {
        // Verify that a unified fn can receive an ArrayValue arg and
        // return it unchanged. Closes the FunctionArg::Array surface.
        let mut r = FunctionRegistry::new();
        r.register_unified("ECHO", echo_first);
        let f = r.lookup_unified("ECHO").unwrap();
        let arr = ArrayValue::row(vec![Value::Number(7.0), Value::Number(8.0)]);
        let ctx = ql_types::EvalContext::default();
        let fctx = FunctionContext::new(&ctx);
        let ret = f(&[FunctionArg::Array(arr.clone())], &fctx);
        match ret {
            FunctionReturn::Array(out) => {
                assert_eq!(out, arr);
            }
            FunctionReturn::Scalar(_) => panic!("expected array round-trip"),
        }
    }

    #[test]
    fn function_return_is_array_helper() {
        let arr = FunctionReturn::Array(ArrayValue::singleton(Value::Number(1.0)));
        let scalar = FunctionReturn::Scalar(Value::Number(1.0));
        assert!(arr.is_array());
        assert!(!scalar.is_array());
    }

    #[test]
    fn lookup_any_returns_tagged_enum() {
        let mut r = FunctionRegistry::new();
        r.register("S", scalar_fns::sum);
        r.register_range_aware("RA", range_fns::sumif);
        r.register_context_aware("CA", echo_date_system_year);
        r.register_unified("UFN", fixed_sequence_3);

        assert!(matches!(r.lookup_any("S"), Some(RegisteredFn::Scalar(_))));
        assert!(matches!(
            r.lookup_any("RA"),
            Some(RegisteredFn::RangeAware(_))
        ));
        assert!(matches!(
            r.lookup_any("CA"),
            Some(RegisteredFn::ContextAware(_))
        ));
        assert!(matches!(
            r.lookup_any("UFN"),
            Some(RegisteredFn::Unified(_))
        ));
        assert!(r.lookup_any("missing").is_none());
    }

    // =====================================================================
    // 6.4-0 substrate — metadata tests (2026-05-28)
    // =====================================================================

    /// **The migration-shim invariant (contract §10.2):** every dispatched
    /// built-in in the default registry has a matching metadata entry —
    /// a `r.register*` call without a Phase 1 / Phase 2 override would
    /// fall back to unknown-fn semantics at the walker. The converse is
    /// NOT required (metadata may carry extra entries — see
    /// `register_builtin_metadata`'s Phase-1 INDIRECT/OFFSET/INFO/CELL
    /// block; those names are graph-volatile but not yet dispatchable.
    /// RANDARRAY left this set in Wave O — it now has both metadata and
    /// dispatch). `default_registry()` debug-asserts the same;
    /// asserting it here too gives a release-build green-light and a
    /// clearer failure message.
    #[test]
    fn default_registry_metadata_covers_every_dispatched_builtin() {
        let r = default_registry();
        let dispatch_keys: Vec<&'static str> = r.fns.keys().copied().collect();
        for name in &dispatch_keys {
            assert!(
                r.metadata(name).is_some(),
                "default_registry missing metadata for dispatched fn {name:?}"
            );
        }
        // Metadata may exceed dispatch — INDIRECT/OFFSET/INFO/CELL are
        // Volatility-tagged but their dispatch is deferred
        // (registry.rs:~647-648). (RANDARRAY was here until Wave O added
        // its dispatch.) Assert the documented superset relationship
        // explicitly so a future drift is visible.
        assert!(
            r.metadata_count() >= r.fns.len(),
            "metadata table must cover at least every dispatched fn"
        );
        // Spot-check a handful, including the dispatch-deferred ones.
        for name in &["SUM", "IF", "VLOOKUP", "NOW", "ROW", "INDIRECT"] {
            assert!(
                r.metadata(name).is_some(),
                "default_registry missing metadata for {name:?}"
            );
        }
    }

    /// **Prior `is_volatile_function` whitelist pin** (was at
    /// `ql-exec::calcgraph_session:149-164`). The substrate puts these
    /// names on the registry as `Volatility::Volatile`
    /// (NOW/TODAY/RAND/RANDBETWEEN/RANDARRAY — recompute every recalc)
    /// or `Volatility::Dynamic` (INDIRECT/OFFSET/INFO/CELL — workbook-
    /// structure sensitive). Both classes are graph-volatile; the
    /// migration shim in `calcgraph_session::is_volatile_function`
    /// returns true for either. This test pins each name to the right
    /// variant so a future shuffle that mis-classifies (e.g. demotes
    /// INDIRECT to `Pure`) surfaces here.
    #[test]
    fn builtin_metadata_pins_prior_volatile_whitelist() {
        let r = default_registry();
        for name in &["NOW", "TODAY", "RAND", "RANDBETWEEN", "RANDARRAY"] {
            let m = r
                .metadata(name)
                .unwrap_or_else(|| panic!("{name} must have metadata"));
            assert_eq!(
                m.volatility,
                Volatility::Volatile,
                "{name} must be Volatile (recompute every recalc)"
            );
            assert!(
                !m.determinism,
                "{name} is non-deterministic (different result on same args at different times)"
            );
        }
        for name in &["INDIRECT", "OFFSET", "INFO", "CELL"] {
            let m = r
                .metadata(name)
                .unwrap_or_else(|| panic!("{name} must have metadata"));
            assert_eq!(
                m.volatility,
                Volatility::Dynamic,
                "{name} must be Dynamic (workbook-structure sensitive)"
            );
            assert!(
                !m.determinism,
                "{name} result depends on workbook structure"
            );
        }
    }

    /// **Prior `is_address_only_reference_fn` whitelist pin** (was at
    /// `ql-exec::calcgraph_session:201-203`).
    ///
    /// **6.4-1 (2026-05-28; I1):** ISREF moved out of `AddressOnly` to
    /// `DepShape::LazyShape` — the walker now skips its arg subtree
    /// entirely rather than routing through `walk_plan_for_address_only_deps`.
    /// Behavior is preserved (both paths skip value-deps on direct refs,
    /// LazyShape additionally skips Binary / Unary / Function subtrees
    /// that `AddressOnly` would still recurse into). The
    /// `isref_carries_lazy_shape_others_carry_address_only` test below
    /// pins the new variant assignment.
    #[test]
    fn builtin_metadata_pins_prior_address_only_whitelist() {
        let r = default_registry();
        for name in &["ROW", "COLUMN", "ROWS", "COLUMNS"] {
            let m = r
                .metadata(name)
                .unwrap_or_else(|| panic!("{name} must have metadata"));
            assert_eq!(
                m.dep_shape,
                DepShape::AddressOnly,
                "{name} must be AddressOnly per design § 5.3"
            );
        }
        // 6.4-1 I1: ISREF is LazyShape now.
        let isref = r.metadata("ISREF").expect("ISREF must have metadata");
        assert_eq!(
            isref.dep_shape,
            DepShape::LazyShape,
            "6.4-1 I1: ISREF must be LazyShape (skip-all-arg-walking contract)"
        );
        // Value-dep reference fns (ISFORMULA / FORMULATEXT) must keep
        // their default `ValueDeps` — the prior whitelist explicitly
        // excluded them and the substrate must preserve that exclusion.
        for name in &["ISFORMULA", "FORMULATEXT"] {
            let m = r
                .metadata(name)
                .unwrap_or_else(|| panic!("{name} must have metadata"));
            assert_eq!(
                m.dep_shape,
                DepShape::ValueDeps,
                "{name} keeps value-deps (formula-status / source-text access, design § 8 R8)"
            );
        }
    }

    /// **UDF-style `register_metadata` happy path:** a previously-
    /// unregistered canonical name accepts metadata and becomes lookup-
    /// visible. Mirrors the 6.4 `EngineSession::register_function`
    /// contract at the registry layer (the trait method delegates here
    /// + maps the error variant).
    #[test]
    fn register_metadata_round_trip_for_a_fresh_name() {
        let mut r = FunctionRegistry::new();
        let meta = FunctionMetadata {
            canonical_name: "MYUDF".to_string(),
            display_name: Some("my_udf".to_string()),
            aliases: vec![],
            arity: Arity::Fixed { n: 1 },
            volatility: Volatility::Pure,
            determinism: true,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::ArrayBatch,
            arg_policy: ArgPolicy::Strict,
            cancellation: CancelPolicy::WorkerKill,
            // **6.4-1:** UDFs taking range args declare Aggregate so the
            // binder admits named-range / range-aware args. This is the
            // expected shape for Python UDFs registered via
            // `qb.register_formula_function` against batch-shaped data.
            arg_context: ArgContext::Aggregate,
            provenance_tags: vec!["python".to_string()],
        };
        assert!(r.register_metadata(meta.clone()).is_ok());
        let read = r.metadata("MYUDF").expect("UDF metadata must be readable");
        assert_eq!(read.canonical_name, "MYUDF");
        assert_eq!(read.batch_shape, BatchShape::ArrayBatch);
        // Case-insensitive lookup (lookup canonicalizes the query).
        assert!(
            r.metadata("myudf").is_some(),
            "metadata lookup must be case-insensitive (matches dispatch convention)"
        );
    }

    /// **Conflict on dup:** registering metadata under a name that
    /// already has metadata returns `Conflict` — never silent
    /// override. Mirrors the dispatch table's duplicate-panic rule
    /// but recoverable (UDF runtime, not boot-time builtin pop).
    #[test]
    fn register_metadata_returns_conflict_on_duplicate() {
        let mut r = default_registry();
        let dup = FunctionMetadata {
            canonical_name: "SUM".to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Pure,
            determinism: true,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::Scalar,
            arg_policy: ArgPolicy::Coercing,
            cancellation: CancelPolicy::Cooperative,
            arg_context: ArgContext::Aggregate,
            provenance_tags: vec![],
        };
        let err = r
            .register_metadata(dup)
            .expect_err("duplicate must fail loud");
        assert!(matches!(
            err,
            FunctionRegistryError::Conflict { ref name } if name == "SUM"
        ));
    }

    /// **Unregister happy path + NotFound + builtin-guard
    /// (6.4-0 audit-fix; Codex A LOW):** removing UDF-style metadata
    /// (no dispatch entry) yields `Ok(())` and removes the entry;
    /// removing an unknown name returns `NotFound`; attempting to
    /// remove a built-in (dispatch entry still present) returns
    /// `Conflict` — never silent removal of a built-in's metadata,
    /// which would silently regress the dep walker for that name.
    #[test]
    fn unregister_metadata_removes_udf_returns_not_found_for_unknown_and_blocks_builtins() {
        let mut r = default_registry();
        // UDF-style: register metadata for a name with NO dispatch
        // entry, then unregister it — round-trip OK.
        let meta = FunctionMetadata {
            canonical_name: "MYUDF".to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Pure,
            determinism: true,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::Scalar,
            arg_policy: ArgPolicy::Coercing,
            cancellation: CancelPolicy::Cooperative,
            arg_context: ArgContext::Scalar,
            provenance_tags: vec![],
        };
        r.register_metadata(meta).expect("UDF metadata registers");
        assert!(r.metadata("MYUDF").is_some());
        r.unregister_metadata("MYUDF").expect("UDF unregister OK");
        assert!(r.metadata("MYUDF").is_none());

        // Second unregister of the same name → NotFound (never silent
        // no-op).
        let err = r
            .unregister_metadata("MYUDF")
            .expect_err("second remove must fail loud");
        assert!(matches!(
            err,
            FunctionRegistryError::NotFound { ref name } if name == "MYUDF"
        ));

        // Case-insensitive: unknown name → NotFound.
        let err = r
            .unregister_metadata("does_not_exist")
            .expect_err("unknown name must fail loud");
        assert!(matches!(err, FunctionRegistryError::NotFound { .. }));

        // Builtin-guard: SUM has a dispatch entry → unregister must
        // refuse with Conflict. This preserves the migration-shim
        // invariant (every dispatched fn has metadata).
        let err = r
            .unregister_metadata("SUM")
            .expect_err("must refuse to unregister a built-in's metadata");
        assert!(
            matches!(err, FunctionRegistryError::Conflict { .. }),
            "removing a built-in's metadata must surface as Conflict, not NotFound"
        );
        // SUM's metadata is untouched.
        assert!(
            r.metadata("SUM").is_some(),
            "builtin guard must preserve SUM's metadata"
        );
    }

    /// **Lowercase guard:** `register_metadata` rejects non-canonical
    /// names loud (asserts, since this is a caller-precondition bug
    /// rather than a runtime collision). Documented at the method.
    #[test]
    #[should_panic(expected = "canonical_name")]
    fn register_metadata_panics_on_non_uppercase_name() {
        let mut r = FunctionRegistry::new();
        let meta = FunctionMetadata {
            canonical_name: "lowercase".to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Pure,
            determinism: true,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::Scalar,
            arg_policy: ArgPolicy::Coercing,
            cancellation: CancelPolicy::Cooperative,
            arg_context: ArgContext::Scalar,
            provenance_tags: vec![],
        };
        let _ = r.register_metadata(meta);
    }

    /// **`iter_metadata` covers everything:** count matches
    /// `metadata_count` and the iterator yields canonical names of
    /// dispatched functions. Used by the (forthcoming, 6.4)
    /// `list_functions` mapper.
    #[test]
    fn iter_metadata_yields_all_registered_entries() {
        let r = default_registry();
        let n = r.iter_metadata().count();
        assert_eq!(n, r.metadata_count());
        assert!(
            r.iter_metadata().any(|m| m.canonical_name == "SUM"),
            "iter_metadata must reach SUM"
        );
    }

    // ===== 6.4-1 substrate-completion tests =====================================

    /// **6.4-1 (2026-05-28; M3):** `sorted_metadata` returns entries in
    /// ascending `canonical_name` order across multiple calls — the
    /// determinism property the (forthcoming) `list_functions` mapper
    /// relies on. HashMap iteration order is not stable across runs;
    /// `sorted_metadata` is the seam the DTO layer reads from.
    #[test]
    fn sorted_metadata_is_deterministic_across_calls() {
        let r = default_registry();
        let first: Vec<&str> = r
            .sorted_metadata()
            .iter()
            .map(|m| m.canonical_name.as_str())
            .collect();
        let second: Vec<&str> = r
            .sorted_metadata()
            .iter()
            .map(|m| m.canonical_name.as_str())
            .collect();
        assert_eq!(first, second, "sorted_metadata MUST be call-stable");
        // Strictly ascending.
        for w in first.windows(2) {
            assert!(
                w[0] < w[1],
                "sorted_metadata violated ordering at {:?} -> {:?}",
                w[0],
                w[1]
            );
        }
        // Covers every metadata entry — same len as iter_metadata.
        assert_eq!(first.len(), r.metadata_count());
    }

    /// **6.4-1 (2026-05-28; I1):** ISREF carries `DepShape::LazyShape`;
    /// the address-only batch (ROW / COLUMN / ROWS / COLUMNS) stays
    /// `AddressOnly`. The walker'\''s migration shims
    /// (`is_address_only_reference_fn` / `is_lazy_shape_reference_fn`)
    /// derive from this — flipping ISREF back to AddressOnly here would
    /// silently regress the LazyShape skip-all-arg-walking contract.
    #[test]
    fn isref_carries_lazy_shape_others_carry_address_only() {
        let r = default_registry();
        assert_eq!(
            r.metadata("ISREF").map(|m| m.dep_shape),
            Some(DepShape::LazyShape),
            "ISREF must register as LazyShape (the only LazyShape builtin in v1)"
        );
        for name in ["ROW", "COLUMN", "ROWS", "COLUMNS"] {
            assert_eq!(
                r.metadata(name).map(|m| m.dep_shape),
                Some(DepShape::AddressOnly),
                "{} must register as AddressOnly (eager + skip value-deps on direct refs)",
                name,
            );
        }
        // ISFORMULA / FORMULATEXT are Eager + workbook query → ValueDeps.
        for name in ["ISFORMULA", "FORMULATEXT"] {
            assert_eq!(
                r.metadata(name).map(|m| m.dep_shape),
                Some(DepShape::ValueDeps),
                "{} keeps value-deps (formula-status access; design § 8 R8)",
                name,
            );
        }
    }

    /// **6.4-1 (2026-05-28; H1):** all 7 reference-aware names carry
    /// `ArgContext::Reference`, and a sample of the ~66 aggregate-list
    /// names carry `ArgContext::Aggregate`. Spelling drift in the
    /// Phase-1.5 override list (mirror of the pre-6.4-1 `matches!`
    /// whitelist at `ql-exec::plan::is_aggregate_function`) is caught
    /// here.
    #[test]
    fn arg_context_overrides_match_pre_6_4_1_whitelists() {
        let r = default_registry();
        // Reference-aware (7 names — Phase 1 in `register_builtin_metadata`).
        for name in [
            "ROW",
            "COLUMN",
            "ROWS",
            "COLUMNS",
            "ISREF",
            "ISFORMULA",
            "FORMULATEXT",
        ] {
            assert_eq!(
                r.metadata(name).map(|m| m.arg_context),
                Some(ArgContext::Reference),
                "{} must register ArgContext::Reference (binder admits literal refs)",
                name,
            );
        }
        // Aggregate sample (covers scalar aggregates, range-aware, unified array,
        // financial, statistical, lookup, order stats — one from each subgroup).
        for name in [
            "SUM",
            "AVERAGE",
            "VLOOKUP",
            "SUMIFS",
            "TRANSPOSE",
            "FILTER",
            "SUBTOTAL",
            "CORREL",
            "XIRR",
            "XLOOKUP",
            "PERCENTILE.INC",
            "MINIFS",
            "TEXTJOIN",
        ] {
            assert_eq!(
                r.metadata(name).map(|m| m.arg_context),
                Some(ArgContext::Aggregate),
                "{} must register ArgContext::Aggregate (binder admits range args; \
                 mirror of pre-6.4-1 `ql-exec::plan::is_aggregate_function` whitelist)",
                name,
            );
        }
        // Sample non-aggregate scalars stay Scalar (the binder rejects range args).
        for name in ["ABS", "SQRT", "IF", "ROUND", "LEN"] {
            assert_eq!(
                r.metadata(name).map(|m| m.arg_context),
                Some(ArgContext::Scalar),
                "{} must register ArgContext::Scalar (pure scalar; binder rejects ranges)",
                name,
            );
        }
    }

    /// **6.4-1 cycle-2 audit-fix M2 (2026-05-28):** exhaustive byte-for-byte
    /// enumeration of all 66 Phase-1.5 `ArgContext::Aggregate` overrides.
    /// The 2-way audit (Codex L1 + Opus M2-OPUS) flagged that
    /// `arg_context_overrides_match_pre_6_4_1_whitelists` above only spot-
    /// checks 13 of 66 names — a future contributor dropping or renaming an
    /// Aggregate name in the Phase-1.5 source list would not be caught by
    /// the sample. This test mirrors the 6.4-0 audit-fix's
    /// `builtin_metadata_pins_prior_address_only_whitelist` pattern: the
    /// 66-name list IS the test fixture, derived directly from the pre-6.4-1
    /// `is_aggregate_function` `matches!` whitelist at
    /// `fdbccb704f7^:crates/ql-exec/src/plan.rs:422-536` (the byte-for-byte
    /// claim the H1 migration is load-bearing on). Order matches the source
    /// list verbatim. Any drift — name dropped from Phase 1.5, name renamed,
    /// metadata pop sequence reordered to overwrite arg_context with the
    /// Scalar default — fails this test loudly. Pair with the existing
    /// `validate.rs` invariants — `is_aggregate_function_lists_only_registered_aggregates`
    /// and `every_range_aware_fn_is_admitted_to_is_aggregate_function` — which
    /// cover the OPPOSITE-direction drift (a name dispatched but not in the
    /// Aggregate set).
    #[test]
    fn phase_1_5_aggregate_overrides_byte_for_byte_against_pre_6_4_1_whitelist() {
        let r = default_registry();
        // The 66-name pre-6.4-1 `plan.rs::is_aggregate_function` whitelist,
        // verbatim from `fdbccb704f7^:crates/ql-exec/src/plan.rs:422-536`.
        // Order preserved so a diff against the pre-6.4-1 source produces
        // a clean visual confirmation.
        let pre_6_4_1_aggregate_whitelist: &[&str] = &[
            // Scalar aggregates (W4-4, W5-58 stats family extras).
            "SUM",
            "AVERAGE",
            "AVG",
            "COUNT",
            "COUNTA",
            "MIN",
            "MAX",
            "PRODUCT",
            "VAR",
            "VAR.S",
            "VAR.P",
            "STDEV",
            "STDEV.S",
            "STDEV.P",
            // Range-aware conditional aggregates (W5-53).
            "SUMIF",
            "COUNTIF",
            // Range-aware lookup family (W5-54).
            "MATCH",
            "INDEX",
            "VLOOKUP",
            "HLOOKUP",
            "CHOOSE",
            // Range-aware conditional-aggregate completion (W5-55).
            "AVERAGEIF",
            "SUMIFS",
            "COUNTIFS",
            "AVERAGEIFS",
            "SUMPRODUCT",
            // Range-aware stats family (W5-58).
            "LARGE",
            "SMALL",
            "RANK",
            "RANK.EQ",
            "RANK.AVG",
            "MEDIAN",
            "MODE",
            "MODE.SNGL",
            // Range-aware text completion (W5-61 polish).
            "CONCAT",
            // Unified-ABI array-returning fns (W5-107 / Phase 4.7.N).
            "TRANSPOSE",
            "FILTER",
            // Range-aware conditional-aggregate dispatcher (W5-D-12).
            "SUBTOTAL",
            // Phase 4.10 statistical paired-array fns (W5-177, W5-178,
            // W5-179, W5-D-6).
            "CORREL",
            "PEARSON",
            "RSQ",
            "STEYX",
            "SLOPE",
            "INTERCEPT",
            "COVARIANCE.P",
            "COVARIANCE.S",
            "SUMX2MY2",
            "SUMX2PY2",
            "SUMXMY2",
            // Phase 4.10 financial cash-flow fns (W5-168, W5-174, W5-D-7).
            "NPV",
            "IRR",
            "MIRR",
            "XNPV",
            "XIRR",
            // Phase 4.10 modern lookup fns (W5-169).
            "XLOOKUP",
            "XMATCH",
            // Phase 4.10 order-statistics fns (W5-D-11).
            "PERCENTILE.INC",
            "PERCENTILE.EXC",
            "PERCENTILE",
            "QUARTILE.INC",
            "QUARTILE.EXC",
            "QUARTILE",
            // Phase 4.10 conditional aggregates / text join (W5-164, W5-167).
            "MINIFS",
            "MAXIFS",
            "COUNTBLANK",
            "TEXTJOIN",
        ];
        assert_eq!(
            pre_6_4_1_aggregate_whitelist.len(),
            66,
            "the byte-for-byte fixture must hold exactly 66 names (matches the cycle-1 \
             commit message's claim about the pre-6.4-1 `is_aggregate_function` size)"
        );

        // Direction A: every pre-6.4-1 name must now register with
        // ArgContext::Aggregate via Phase 1.5. Any drop / rename / Phase-1-
        // override-after-Phase-1.5-bug surfaces here.
        for name in pre_6_4_1_aggregate_whitelist {
            let meta = r
                .metadata(name)
                .unwrap_or_else(|| panic!("{name}: pre-6.4-1 Aggregate name has no metadata at all (Phase 1.5 dropped it)"));
            assert_eq!(
                meta.arg_context,
                ArgContext::Aggregate,
                "{name}: pre-6.4-1 `is_aggregate_function` whitelist member \
                 registered with arg_context={:?} instead of Aggregate — \
                 cycle-1 H1 migration drifted",
                meta.arg_context,
            );
        }

        // Direction B (sanity): no name OUTSIDE the pre-6.4-1 whitelist
        // should silently flip to ArgContext::Aggregate via a Phase-1.5 typo
        // / accidental extra entry. Walk every metadata entry; any
        // Aggregate-tagged name must be in the whitelist OR in the explicit
        // post-6.4-1 additions allowlist below (legitimate extensions added
        // AFTER the byte-for-byte migration — each must be pinned here so a
        // typo'd extra entry still fails loudly).
        //
        // **B2 (native quant fns):** SHARPE + MAX_DRAWDOWN (and Wave A's
        // VOLATILITY + SORTINO) are new range-aware quant aggregates that
        // postdate the pre-6.4-1 whitelist. They are legitimately Aggregate
        // (the binder must hand them the range), so they are listed here as
        // explicit post-migration extensions.
        let post_6_4_1_aggregate_additions: &[&str] =
            &["SHARPE", "MAX_DRAWDOWN", "VOLATILITY", "SORTINO"];
        let mut allowed: std::collections::HashSet<&str> =
            pre_6_4_1_aggregate_whitelist.iter().copied().collect();
        allowed.extend(post_6_4_1_aggregate_additions.iter().copied());
        for m in r.iter_metadata() {
            if m.arg_context == ArgContext::Aggregate {
                assert!(
                    allowed.contains(m.canonical_name.as_str()),
                    "{}: registered with arg_context=Aggregate but is NOT in the \
                     pre-6.4-1 `is_aggregate_function` whitelist nor the explicit \
                     post-6.4-1 additions allowlist — a name was silently added \
                     to the Phase-1.5 override list. If intentional, add it to \
                     `post_6_4_1_aggregate_additions`.",
                    m.canonical_name,
                );
            }
        }
    }

    /// **B2 (native quant fns):** SHARPE + MAX_DRAWDOWN must register
    /// `ArgContext::Aggregate` so the binder routes their range arg through
    /// `AggregateNameRef` / `RangeRef` instead of an implicitly-intersected
    /// scalar. Mirrors `arg_context_overrides_match_pre_6_4_1_whitelists` for
    /// the two new names (which are deliberately excluded from the
    /// byte-for-byte pre-6.4-1 fixture). The full lex→parse→bind→eval armor
    /// lives in `ql-exec::workbook_runtime::validate::b2_*`.
    #[test]
    fn b2_quant_fns_admitted_to_is_aggregate_function() {
        let r = default_registry();
        for name in ["SHARPE", "MAX_DRAWDOWN", "VOLATILITY", "SORTINO"] {
            assert_eq!(
                r.metadata(name).map(|m| m.arg_context),
                Some(ArgContext::Aggregate),
                "{name} must register ArgContext::Aggregate (binder admits the \
                 range arg; otherwise =SHARPE(A1:A10) collapses to a scalar)",
            );
            assert!(
                r.lookup_range_aware(name).is_some(),
                "{name} must be registered in the range-aware dispatch table",
            );
            assert!(
                r.lookup(name).is_none(),
                "{name} is range-aware ONLY; must not also appear in the scalar table",
            );
        }
    }

    /// **6.4-1 (2026-05-28; H3):** `fn_generation()` ticks monotonically
    /// on `register_metadata` / `unregister_metadata` success only. The
    /// `PlanCache` reads this value into `PlanCacheKey::fn_gen`; a tick
    /// invalidates every plan bound before the tick → next eval re-binds
    /// against current metadata. Closes the contract §10.3
    /// "re-extract deps" half.
    #[test]
    fn fn_gen_ticks_on_successful_register_and_unregister() {
        let mut r = default_registry();
        let initial = r.fn_generation();
        assert!(
            initial > 0,
            "default_registry runs ~260+ register_metadata calls at boot"
        );

        // Successful register bumps once.
        let meta = FunctionMetadata {
            canonical_name: "MYUDF1".to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Pure,
            determinism: true,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::ArrayBatch,
            arg_policy: ArgPolicy::Coercing,
            cancellation: CancelPolicy::WorkerKill,
            arg_context: ArgContext::Aggregate,
            provenance_tags: vec![],
        };
        r.register_metadata(meta).unwrap();
        assert_eq!(
            r.fn_generation(),
            initial + 1,
            "register_metadata MUST bump fn_gen"
        );

        // Successful unregister bumps again.
        r.unregister_metadata("MYUDF1").unwrap();
        assert_eq!(
            r.fn_generation(),
            initial + 2,
            "unregister_metadata MUST bump fn_gen"
        );

        // Failed register (Conflict) MUST NOT bump.
        let snapshot = r.fn_generation();
        let dup = FunctionMetadata {
            canonical_name: "SUM".to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Pure,
            determinism: true,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::Scalar,
            arg_policy: ArgPolicy::Coercing,
            cancellation: CancelPolicy::Cooperative,
            arg_context: ArgContext::Aggregate,
            provenance_tags: vec![],
        };
        assert!(r.register_metadata(dup).is_err());
        assert_eq!(
            r.fn_generation(),
            snapshot,
            "failed register_metadata (Conflict) MUST leave fn_gen untouched"
        );

        // Failed unregister (NotFound) MUST NOT bump.
        let snapshot = r.fn_generation();
        assert!(r.unregister_metadata("DOES_NOT_EXIST").is_err());
        assert_eq!(
            r.fn_generation(),
            snapshot,
            "failed unregister_metadata (NotFound) MUST leave fn_gen untouched"
        );

        // Failed unregister (Conflict — builtin guard) MUST NOT bump either.
        let snapshot = r.fn_generation();
        assert!(r.unregister_metadata("SUM").is_err());
        assert_eq!(
            r.fn_generation(),
            snapshot,
            "failed unregister_metadata (builtin Conflict) MUST leave fn_gen untouched"
        );
    }

    // ===== 6.4-2 trait-wiring substrate tests ============================

    /// **6.4-2 (2026-05-28):** the `register_udf` combined path inserts
    /// BOTH metadata + handle atomically; `udf_handle` reads back what
    /// was stored. Pairs with the `WorkbookSession::register_function`
    /// trait method that calls `register_udf` from the engine side.
    #[test]
    fn register_udf_inserts_metadata_and_handle_atomically() {
        let mut r = default_registry();
        let initial_gen = r.fn_generation();
        let meta = FunctionMetadata {
            canonical_name: "MYUDF".to_string(),
            display_name: Some("My UDF".to_string()),
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Volatile,
            determinism: false,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::ArrayBatch,
            arg_policy: ArgPolicy::Strict,
            cancellation: CancelPolicy::WorkerKill,
            arg_context: ArgContext::Aggregate,
            provenance_tags: vec!["python".to_string()],
        };
        let handle = FunctionImplHandle(0xDEAD_BEEF);
        r.register_udf(meta, handle).expect("register_udf clean");
        // Metadata side: present + faithful.
        let got = r.metadata("MYUDF").expect("metadata present");
        assert_eq!(got.volatility, Volatility::Volatile);
        assert_eq!(got.batch_shape, BatchShape::ArrayBatch);
        assert_eq!(got.arg_context, ArgContext::Aggregate);
        // Handle side: present + faithful; case-insensitive lookup.
        assert_eq!(r.udf_handle("MYUDF"), Some(handle));
        assert_eq!(
            r.udf_handle("myudf"),
            Some(handle),
            "udf_handle MUST be case-insensitive"
        );
        // Single fn_gen bump (from the inner register_metadata).
        assert_eq!(
            r.fn_generation(),
            initial_gen + 1,
            "register_udf MUST bump fn_gen exactly once (via register_metadata)"
        );
    }

    /// **6.4-2 (2026-05-28):** built-ins have no UDF handle — the
    /// `udf_handles` table only carries UDF entries. Verifies the
    /// invariant that `udf_handle(builtin_name) == None` even though
    /// `metadata(builtin_name)` is `Some`.
    #[test]
    fn udf_handle_returns_none_for_builtins_and_unknown_names() {
        let r = default_registry();
        // SUM is a built-in: has metadata but no UDF handle.
        assert!(r.metadata("SUM").is_some());
        assert_eq!(r.udf_handle("SUM"), None);
        // ROW (also built-in, reference-aware): same.
        assert!(r.metadata("ROW").is_some());
        assert_eq!(r.udf_handle("ROW"), None);
        // Unknown name: None on both sides.
        assert!(r.metadata("MYUDF").is_none());
        assert_eq!(r.udf_handle("MYUDF"), None);
    }

    /// **6.4-2 (2026-05-28):** `unregister_metadata` removes the
    /// matching `udf_handles` entry symmetrically — closes the invariant
    /// "every key in `udf_handles` has a matching `metadata` entry."
    /// Without this, a register-then-unregister-then-re-register-as-
    /// metadata-only sequence would leak the stale handle.
    #[test]
    fn unregister_metadata_clears_udf_handle_symmetrically() {
        let mut r = default_registry();
        let meta = FunctionMetadata {
            canonical_name: "MYUDF".to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Pure,
            determinism: true,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::Scalar,
            arg_policy: ArgPolicy::Coercing,
            cancellation: CancelPolicy::Cooperative,
            arg_context: ArgContext::Scalar,
            provenance_tags: vec![],
        };
        r.register_udf(meta, FunctionImplHandle(42))
            .expect("register_udf clean");
        assert!(r.udf_handle("MYUDF").is_some());
        r.unregister_metadata("MYUDF").expect("unregister clean");
        // Handle is cleared atomically with the metadata removal.
        assert_eq!(
            r.udf_handle("MYUDF"),
            None,
            "unregister_metadata MUST clear the matching udf_handles entry"
        );
    }

    /// **6.4-2 (2026-05-28):** the atomicity property — if
    /// `register_udf`'s inner `register_metadata` call returns
    /// `Conflict`, the handle table is NOT mutated (the early-return
    /// happens before the `udf_handles.insert` line). This pins the
    /// "metadata-first, handle-second-only-on-success" invariant: an
    /// auditor reading this test understands that a partial state
    /// (handle without metadata) is impossible.
    #[test]
    fn register_udf_conflict_does_not_insert_handle() {
        let mut r = default_registry();
        // Pre-register MYUDF metadata directly (no handle).
        let meta = FunctionMetadata {
            canonical_name: "MYUDF".to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Pure,
            determinism: true,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::Scalar,
            arg_policy: ArgPolicy::Coercing,
            cancellation: CancelPolicy::Cooperative,
            arg_context: ArgContext::Scalar,
            provenance_tags: vec![],
        };
        r.register_metadata(meta).expect("metadata-only registers");
        assert_eq!(
            r.udf_handle("MYUDF"),
            None,
            "metadata-only path leaves handle empty"
        );

        // Now register_udf with a colliding name → Conflict → handle MUST stay empty.
        let dup_meta = FunctionMetadata {
            canonical_name: "MYUDF".to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Volatile,
            determinism: false,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::ArrayBatch,
            arg_policy: ArgPolicy::Strict,
            cancellation: CancelPolicy::WorkerKill,
            arg_context: ArgContext::Aggregate,
            provenance_tags: vec![],
        };
        let err = r
            .register_udf(dup_meta, FunctionImplHandle(99))
            .expect_err("collision MUST surface as Conflict");
        assert!(matches!(
            err,
            FunctionRegistryError::Conflict { ref name } if name == "MYUDF"
        ));
        assert_eq!(
            r.udf_handle("MYUDF"),
            None,
            "Conflict short-circuits BEFORE udf_handles.insert — no partial state"
        );

        // The prior metadata-only entry is UNCHANGED — the conflicting
        // register_metadata never reached the `metadata.insert` line
        // either, so the original Volatility::Pure entry survives.
        assert_eq!(
            r.metadata("MYUDF").unwrap().volatility,
            Volatility::Pure,
            "register_udf Conflict MUST NOT overwrite the existing metadata"
        );
    }
}
