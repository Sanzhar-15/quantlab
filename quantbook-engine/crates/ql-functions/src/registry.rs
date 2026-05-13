//! Function registry — name → implementation dispatch.
//!
//! Names are stored uppercase per Excel canon. Lookup is case-insensitive: the caller
//! can pass `"sum"`, `"SUM"`, or `"Sum"` and get the same function.

use std::collections::HashMap;

use ql_types::Value;

use crate::range_aware_fns::RangeAwareFn;
use crate::{range_fns, scalar_fns, volatile};

/// Function signature: pre-evaluated args → result Value.
pub type ScalarFn = fn(&[Value]) -> Value;

/// Phase 0 function registry. Built by `default_registry()` with the W4-4 function set.
///
/// W5-53 adds a parallel `range_aware_fns` table for functions that
/// need per-argument range-vs-scalar metadata (SUMIF, COUNTIF, etc.).
/// Lookup checks the range-aware table first; falls back to the
/// scalar table. A single name MUST NOT be registered in both
/// (registration panics if there's a conflict).
#[derive(Clone, Debug)]
pub struct FunctionRegistry {
    fns: HashMap<&'static str, ScalarFn>,
    range_aware_fns: HashMap<&'static str, RangeAwareFn>,
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
        let prior = self.range_aware_fns.insert(name, f);
        assert!(
            prior.is_none(),
            "FunctionRegistry::register_range_aware: duplicate registration for {name:?}"
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

    pub fn names(&self) -> impl Iterator<Item = &&'static str> {
        self.fns.keys()
    }

    pub fn len(&self) -> usize {
        self.fns.len() + self.range_aware_fns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.fns.is_empty() && self.range_aware_fns.is_empty()
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
    r.register("NOW", volatile::now);
    r.register("TODAY", volatile::today);
    r.register("RAND", volatile::rand);
    r.register("RANDBETWEEN", volatile::randbetween);

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
        // MODE.SNGL alias = 7).
        assert_eq!(r.len(), 102);
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
