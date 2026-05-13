//! Function registry — name → implementation dispatch.
//!
//! Names are stored uppercase per Excel canon. Lookup is case-insensitive: the caller
//! can pass `"sum"`, `"SUM"`, or `"Sum"` and get the same function.

use std::collections::HashMap;

use ql_types::Value;

use crate::context_aware_fns::ContextAwareFn;
use crate::range_aware_fns::RangeAwareFn;
use crate::{date_fns, range_fns, scalar_fns, volatile};

/// Function signature: pre-evaluated args → result Value.
pub type ScalarFn = fn(&[Value]) -> Value;

/// Phase 0 function registry. Built by `default_registry()` with the W4-4 function set.
///
/// W5-53 adds a parallel `range_aware_fns` table for functions that
/// need per-argument range-vs-scalar metadata (SUMIF, COUNTIF, etc.).
/// W5-69 (Phase 4.5.A.0) adds `context_aware_fns` for date/locale/clock-
/// aware functions that take an extra `&EvalContext` arg. Dispatch order:
/// range_aware FIRST → context_aware SECOND → scalar LAST. A single name
/// MUST NOT be registered in more than one table (registration panics on
/// any cross-table collision).
#[derive(Clone, Debug)]
pub struct FunctionRegistry {
    fns: HashMap<&'static str, ScalarFn>,
    range_aware_fns: HashMap<&'static str, RangeAwareFn>,
    context_aware_fns: HashMap<&'static str, ContextAwareFn>,
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
            range_aware_fns: HashMap::new(),
            context_aware_fns: HashMap::new(),
        }
    }

    /// Register a function under `name`.
    ///
    /// Phase 2A.7 audit M5: `name` MUST already be canonical upper-case. This is
    /// asserted at registration time so a stray `register("sum", ...)` doesn't
    /// silently create an unreachable entry (lookups uppercase the query, so a
    /// lower-case key would never be found). Duplicate registrations also
    /// panic — silent override would let a typo replace a built-in with a buggy
    /// shim. Phase 2 has a closed default function set; if dynamic registration
    /// ever becomes a real use case, swap this for `Result<(), RegisterError>`.
    pub fn register(&mut self, name: &'static str, f: ScalarFn) {
        assert!(
            !name.is_empty(),
            "FunctionRegistry::register: name must not be empty"
        );
        assert!(
            name.bytes().all(|b| !b.is_ascii_lowercase()),
            "FunctionRegistry::register: name {name:?} must be canonical upper-case; \
             lookups uppercase the query, so a lower-case key is unreachable"
        );
        // W5-69 (Phase 4.5.A.0): cross-table disjointness — a name
        // already in range_aware_fns or context_aware_fns cannot also
        // be registered as scalar.
        assert!(
            !self.range_aware_fns.contains_key(name),
            "FunctionRegistry::register: {name:?} is already registered as a \
             range-aware function; cannot register in both tables"
        );
        assert!(
            !self.context_aware_fns.contains_key(name),
            "FunctionRegistry::register: {name:?} is already registered as a \
             context-aware function; cannot register in both tables"
        );
        let prior = self.fns.insert(name, f);
        assert!(
            prior.is_none(),
            "FunctionRegistry::register: duplicate registration for {name:?} — \
             silent override would let a typo replace a built-in"
        );
    }

    /// W5-53: register a range-aware function under `name`. Same
    /// canonical-uppercase requirement + duplicate panic as
    /// `register`. Cross-table name collision also panics — a name
    /// cannot live in both `fns` and `range_aware_fns`.
    pub fn register_range_aware(&mut self, name: &'static str, f: RangeAwareFn) {
        assert!(
            !name.is_empty(),
            "FunctionRegistry::register_range_aware: name must not be empty"
        );
        assert!(
            name.bytes().all(|b| !b.is_ascii_lowercase()),
            "FunctionRegistry::register_range_aware: name {name:?} must be canonical \
             upper-case"
        );
        assert!(
            !self.fns.contains_key(name),
            "FunctionRegistry::register_range_aware: {name:?} is already registered \
             as a scalar function; cannot register in both tables"
        );
        // W5-69 (Phase 4.5.A.0): also disjoint from context_aware_fns.
        assert!(
            !self.context_aware_fns.contains_key(name),
            "FunctionRegistry::register_range_aware: {name:?} is already registered \
             as a context-aware function; cannot register in both tables"
        );
        let prior = self.range_aware_fns.insert(name, f);
        assert!(
            prior.is_none(),
            "FunctionRegistry::register_range_aware: duplicate registration for {name:?}"
        );
    }

    /// **W5-69 (Phase 4.5.A.0):** register a context-aware function. These
    /// receive `&EvalContext` (date_system + locale + now_provider) in
    /// addition to the standard `&[Value]` args. Same canonical-uppercase
    /// requirement + duplicate panic + cross-table disjointness as the
    /// other two `register_*` methods.
    pub fn register_context_aware(&mut self, name: &'static str, f: ContextAwareFn) {
        assert!(
            !name.is_empty(),
            "FunctionRegistry::register_context_aware: name must not be empty"
        );
        assert!(
            name.bytes().all(|b| !b.is_ascii_lowercase()),
            "FunctionRegistry::register_context_aware: name {name:?} must be canonical \
             upper-case"
        );
        assert!(
            !self.fns.contains_key(name),
            "FunctionRegistry::register_context_aware: {name:?} is already registered \
             as a scalar function; cannot register in both tables"
        );
        assert!(
            !self.range_aware_fns.contains_key(name),
            "FunctionRegistry::register_context_aware: {name:?} is already registered \
             as a range-aware function; cannot register in both tables"
        );
        let prior = self.context_aware_fns.insert(name, f);
        assert!(
            prior.is_none(),
            "FunctionRegistry::register_context_aware: duplicate registration for {name:?}"
        );
    }

    /// Case-insensitive lookup. Returns `None` if not registered.
    pub fn lookup(&self, name: &str) -> Option<ScalarFn> {
        // Allocate a single uppercase key for the lookup; the registry holds &'static
        // uppercase names, so we compare on uppercase form.
        let upper = name.to_ascii_uppercase();
        self.fns.get(upper.as_str()).copied()
    }

    /// W5-53: case-insensitive lookup in the range-aware table.
    /// Callers should check this BEFORE `lookup` — if a function is
    /// range-aware, the dispatch must construct `Vec<FnArg>` rather
    /// than flattening to `Vec<Value>`.
    pub fn lookup_range_aware(&self, name: &str) -> Option<RangeAwareFn> {
        let upper = name.to_ascii_uppercase();
        self.range_aware_fns.get(upper.as_str()).copied()
    }

    /// **W5-69 (Phase 4.5.A.0):** case-insensitive lookup in the
    /// context-aware table. Callers should check this AFTER
    /// `lookup_range_aware` but BEFORE `lookup`. Dispatch order:
    /// `range_aware` → `context_aware` → `scalar`.
    pub fn lookup_context_aware(&self, name: &str) -> Option<ContextAwareFn> {
        let upper = name.to_ascii_uppercase();
        self.context_aware_fns.get(upper.as_str()).copied()
    }

    pub fn names(&self) -> impl Iterator<Item = &&'static str> {
        self.fns.keys()
    }

    /// W5-65 (Phase 4.4.B; Codex MEDIUM 4 fix): names registered in the
    /// range-aware table. The original `names()` only exposes scalar names;
    /// any coverage report or registry-walk that wants to enumerate ALL
    /// registered functions (e.g. for matrix-test completeness) must call
    /// both `names()` and `range_aware_names()`.
    pub fn range_aware_names(&self) -> impl Iterator<Item = &&'static str> {
        self.range_aware_fns.keys()
    }

    /// **W5-69 (Phase 4.5.A.0):** names registered in the context-aware
    /// table. Same pattern as `range_aware_names()`; coverage walks must
    /// include this iterator OR use `names_all()` (which chains all 3).
    pub fn context_aware_names(&self) -> impl Iterator<Item = &&'static str> {
        self.context_aware_fns.keys()
    }

    /// W5-65 (Phase 4.4.B): convenience iterator over ALL registered function
    /// names across all tables (scalar + range-aware + context-aware). The
    /// three tables are disjoint by registration invariant, so no
    /// deduplication is needed. **W5-69 (Phase 4.5.A.0):** extended to chain
    /// the context-aware table.
    pub fn names_all(&self) -> impl Iterator<Item = &&'static str> {
        self.fns
            .keys()
            .chain(self.range_aware_fns.keys())
            .chain(self.context_aware_fns.keys())
    }

    pub fn len(&self) -> usize {
        self.fns.len() + self.range_aware_fns.len() + self.context_aware_fns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.fns.is_empty() && self.range_aware_fns.is_empty() && self.context_aware_fns.is_empty()
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
    // canon deferred to Phase 4.9).
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
        // of 6; NETWORKDAYS.INTL + WORKDAY.INTL deferred to tier-4).
        assert_eq!(r.len(), 129);
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
    fn scalar_and_range_aware_tables_are_disjoint() {
        let r = default_registry();
        // No name appears in both tables.
        for (name, _) in r.fns.iter() {
            assert!(
                !r.range_aware_fns.contains_key(name),
                "name {name:?} is in both fns and range_aware_fns"
            );
        }
    }

    #[test]
    #[should_panic(expected = "is already registered as a scalar function")]
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
    fn context_aware_table_disjoint_from_scalar() {
        let r = default_registry();
        for (name, _) in r.fns.iter() {
            assert!(
                !r.context_aware_fns.contains_key(name),
                "{name:?} appears in both fns and context_aware_fns"
            );
        }
    }

    #[test]
    fn context_aware_table_disjoint_from_range_aware() {
        let r = default_registry();
        for (name, _) in r.range_aware_fns.iter() {
            assert!(
                !r.context_aware_fns.contains_key(name),
                "{name:?} appears in both range_aware_fns and context_aware_fns"
            );
        }
    }

    #[test]
    #[should_panic(expected = "is already registered as a scalar function")]
    fn register_context_aware_with_existing_scalar_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register("FOO", scalar_fns::sum);
        r.register_context_aware("FOO", echo_date_system_year);
    }

    #[test]
    #[should_panic(expected = "is already registered as a range-aware function")]
    fn register_context_aware_with_existing_range_aware_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register_range_aware("FOO", range_fns::sumif);
        r.register_context_aware("FOO", echo_date_system_year);
    }

    #[test]
    #[should_panic(expected = "is already registered as a context-aware function")]
    fn register_scalar_with_existing_context_aware_name_panics() {
        let mut r = FunctionRegistry::new();
        r.register_context_aware("FOO", echo_date_system_year);
        r.register("FOO", scalar_fns::sum);
    }

    #[test]
    #[should_panic(expected = "is already registered as a context-aware function")]
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
}
