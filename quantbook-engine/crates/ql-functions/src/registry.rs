//! Function registry — name → implementation dispatch.
//!
//! Names are stored uppercase per Excel canon. Lookup is case-insensitive: the caller
//! can pass `"sum"`, `"SUM"`, or `"Sum"` and get the same function.

use std::collections::HashMap;

use ql_types::Value;

use crate::scalar_fns;

/// Function signature: pre-evaluated args → result Value.
pub type ScalarFn = fn(&[Value]) -> Value;

/// Phase 0 function registry. Built by `default_registry()` with the W4-4 function set.
#[derive(Clone, Debug)]
pub struct FunctionRegistry {
    fns: HashMap<&'static str, ScalarFn>,
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

    /// Register a function under `name`. `name` is the canonical uppercase form; lookup
    /// is case-insensitive at `lookup` time.
    pub fn register(&mut self, name: &'static str, f: ScalarFn) {
        self.fns.insert(name, f);
    }

    /// Case-insensitive lookup. Returns `None` if not registered.
    pub fn lookup(&self, name: &str) -> Option<ScalarFn> {
        // Allocate a single uppercase key for the lookup; the registry holds &'static
        // uppercase names, so we compare on uppercase form.
        let upper = name.to_ascii_uppercase();
        self.fns.get(upper.as_str()).copied()
    }

    pub fn names(&self) -> impl Iterator<Item = &&'static str> {
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

    // Math
    r.register("ABS", scalar_fns::abs);
    r.register("SQRT", scalar_fns::sqrt);
    r.register("ROUND", scalar_fns::round);
    r.register("INT", scalar_fns::int);
    r.register("MOD", scalar_fns::r#mod);
    r.register("POWER", scalar_fns::power);

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
        // 25 entries — 22 distinct functions + 3 aliases (AVG, VAR, STDEV).
        assert_eq!(r.len(), 25);
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
