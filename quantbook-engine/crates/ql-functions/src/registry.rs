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

use ql_types::{ArrayValue, EvalContext, Value};

use crate::context_aware_fns::ContextAwareFn;
use crate::range_aware_fns::RangeAwareFn;
use crate::{date_fns, financial_fns, format, range_fns, scalar_fns, volatile};

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
        }
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
    // half. RANDARRAY / INDIRECT / OFFSET / INFO / CELL stay deferred
    // to the Phase 4.3 function library expansion.
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

    r
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
        // total).
        assert_eq!(r.len(), 177);
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
}
