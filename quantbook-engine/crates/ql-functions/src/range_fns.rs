//! Range-aware function implementations (W5-53, Phase 4.3 V2).
//!
//! Functions that take BOTH range arguments AND scalar criteria —
//! the family the existing `ScalarFn = fn(&[Value]) -> Value` shape
//! couldn't dispatch correctly. See `range_aware_fns.rs` for the
//! `FnArg` / `RangeAwareFn` types and `registry.rs` for the parallel
//! dispatch table.
//!
//! W5-53 V1 batch:
//! - SUMIF(range, criteria, [sum_range])
//! - COUNTIF(range, criteria)
//!
//! Future (V2 batch tail): SUMIFS / COUNTIFS / AVERAGEIF / AVERAGEIFS /
//! SUMPRODUCT, then the lookup family.
//!
//! ## Criteria semantics
//!
//! Excel criteria can be:
//! - **Number**: `5` — exact match.
//! - **Bool**: `TRUE` / `FALSE` — exact match.
//! - **Text without operator prefix**: `"hello"` — case-insensitive
//!   equality with the cell value's text representation.
//! - **Text with operator prefix**: `">5"`, `"<=10"`, `"<>foo"`,
//!   `"=5"`, `">=2.5"`, `"<0"` — comparison.
//!
//! ## Not supported in this V1
//!
//! - Wildcards (`?` for single char, `*` for any chars). Deferred to
//!   a V2 follow-up (text-criteria expansion).
//! - Regex / pattern matching.
//! - Locale-dependent comparators.
//! - Date-string criteria like `">2020-01-01"` (Phase 4.5).
//!
//! These limitations are noted in `docs/compat/excel-matrix.md`.

use ql_types::{coercion, ErrorValue, Value};

use crate::range_aware_fns::FnArg;

/// Helper: coerce a Value to a numeric f64 for sum-style accumulation.
/// Errors propagate; Blank skips; Bool coerces (TRUE=1.0, FALSE=0.0);
/// Text → #VALUE! (strict — matches scalar_fns module canon).
enum NumericArg {
    Number(f64),
    Skip,
    Error(ErrorValue),
}

fn coerce_numeric(v: &Value) -> NumericArg {
    match v {
        Value::Error(e) => NumericArg::Error(*e),
        Value::Blank => NumericArg::Skip,
        other => match coercion::to_number_strict(other) {
            Ok(n) => NumericArg::Number(n),
            Err(e) => NumericArg::Error(e),
        },
    }
}

/// Comparison operator parsed from a criteria string like `">5"`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum CmpOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// Compiled predicate that decides whether a cell value matches
/// the user-supplied criteria.
enum Predicate {
    /// Compare a numeric cell value against a numeric target.
    /// Non-numeric cell values never match.
    Numeric(CmpOp, f64),
    /// Compare a text cell value against a text target (case-
    /// insensitive). For Eq/Ne, numeric-text equivalence is also
    /// honored: `=5` matches Value::Number(5.0) AND Value::Text("5").
    /// For ordered comparisons (Lt/Le/Gt/Ge), Text-only ordering.
    Text(CmpOp, String),
    /// Boolean equality / inequality.
    Boolean(CmpOp, bool),
    /// Blank-criteria match: criteria is `""` (empty text) → matches
    /// Value::Blank AND Value::Text("").
    Blank(CmpOp),
}

impl Predicate {
    fn matches(&self, v: &Value) -> bool {
        match self {
            Predicate::Numeric(op, target) => match v {
                Value::Number(n) => apply_cmp(*op, *n, *target),
                Value::Boolean(b) => apply_cmp(*op, if *b { 1.0 } else { 0.0 }, *target),
                Value::Text(s) => {
                    // Lenient: if the text parses as a number, compare
                    // numerically. Otherwise Eq always false, Ne always
                    // true (mirrors Excel "text never equals number").
                    if let Ok(n) = s.as_ref().trim().parse::<f64>() {
                        apply_cmp(*op, n, *target)
                    } else {
                        matches!(op, CmpOp::Ne)
                    }
                }
                Value::Blank => match op {
                    // Numeric Eq against blank: blank coerces to 0 in
                    // numeric context per Excel SUMIF canon.
                    CmpOp::Eq => *target == 0.0,
                    CmpOp::Ne => *target != 0.0,
                    _ => apply_cmp(*op, 0.0, *target),
                },
                Value::Error(_) => false,
            },
            Predicate::Text(op, target) => match v {
                Value::Text(s) => apply_text_cmp(*op, s.as_ref(), target),
                Value::Number(n) => {
                    // Numeric vs text criteria: Eq/Ne are honored if
                    // the target text parses as the same number.
                    if let Ok(t) = target.parse::<f64>() {
                        apply_cmp(*op, *n, t)
                    } else {
                        matches!(op, CmpOp::Ne)
                    }
                }
                Value::Boolean(b) => {
                    let bs = if *b { "TRUE" } else { "FALSE" };
                    apply_text_cmp(*op, bs, target)
                }
                Value::Blank => apply_text_cmp(*op, "", target),
                Value::Error(_) => false,
            },
            Predicate::Boolean(op, target) => match v {
                Value::Boolean(b) => match op {
                    CmpOp::Eq => *b == *target,
                    CmpOp::Ne => *b != *target,
                    _ => false, // No ordering on bools.
                },
                _ => matches!(op, CmpOp::Ne),
            },
            Predicate::Blank(op) => {
                let is_blank = matches!(v, Value::Blank)
                    || matches!(v, Value::Text(s) if s.as_ref().is_empty());
                match op {
                    CmpOp::Eq => is_blank,
                    CmpOp::Ne => !is_blank,
                    _ => false,
                }
            }
        }
    }
}

fn apply_cmp(op: CmpOp, lhs: f64, rhs: f64) -> bool {
    match op {
        CmpOp::Eq => lhs == rhs,
        CmpOp::Ne => lhs != rhs,
        CmpOp::Lt => lhs < rhs,
        CmpOp::Le => lhs <= rhs,
        CmpOp::Gt => lhs > rhs,
        CmpOp::Ge => lhs >= rhs,
    }
}

fn apply_text_cmp(op: CmpOp, lhs: &str, rhs: &str) -> bool {
    let l = lhs.to_uppercase();
    let r = rhs.to_uppercase();
    match op {
        CmpOp::Eq => l == r,
        CmpOp::Ne => l != r,
        CmpOp::Lt => l < r,
        CmpOp::Le => l <= r,
        CmpOp::Gt => l > r,
        CmpOp::Ge => l >= r,
    }
}

/// Parse a user-supplied criteria `Value` into a `Predicate`. Returns
/// `Err(#VALUE!)` if the criteria can't be interpreted.
fn build_predicate(criteria: &Value) -> Result<Predicate, ErrorValue> {
    match criteria {
        Value::Error(e) => Err(*e),
        Value::Number(n) => Ok(Predicate::Numeric(CmpOp::Eq, *n)),
        Value::Boolean(b) => Ok(Predicate::Boolean(CmpOp::Eq, *b)),
        Value::Blank => Ok(Predicate::Blank(CmpOp::Eq)),
        Value::Text(s) => {
            let s = s.as_ref();
            // Operator prefix: ">=" "<=" "<>" ">" "<" "=" (in length
            // order so two-char ops are tried first).
            let (op, rest) = if let Some(r) = s.strip_prefix(">=") {
                (CmpOp::Ge, r)
            } else if let Some(r) = s.strip_prefix("<=") {
                (CmpOp::Le, r)
            } else if let Some(r) = s.strip_prefix("<>") {
                (CmpOp::Ne, r)
            } else if let Some(r) = s.strip_prefix('>') {
                (CmpOp::Gt, r)
            } else if let Some(r) = s.strip_prefix('<') {
                (CmpOp::Lt, r)
            } else if let Some(r) = s.strip_prefix('=') {
                (CmpOp::Eq, r)
            } else {
                (CmpOp::Eq, s)
            };
            let rest = rest.trim();
            // Empty rest after stripping `<>` / `=` etc. is the blank
            // match.
            if rest.is_empty() {
                return Ok(Predicate::Blank(op));
            }
            // Try to parse as a number first; fall back to text/bool.
            if let Ok(n) = rest.parse::<f64>() {
                return Ok(Predicate::Numeric(op, n));
            }
            // Bool: case-insensitive TRUE / FALSE.
            let upper = rest.to_ascii_uppercase();
            if upper == "TRUE" {
                return Ok(Predicate::Boolean(op, true));
            }
            if upper == "FALSE" {
                return Ok(Predicate::Boolean(op, false));
            }
            // Default: text comparison.
            Ok(Predicate::Text(op, rest.to_string()))
        }
    }
}

/// `SUMIF(range, criteria, [sum_range])` — sum cells in `sum_range`
/// (or `range` if `sum_range` omitted) where the corresponding cell
/// in `range` matches `criteria`.
///
/// Shape: the two ranges are paired element-wise. If `sum_range` is
/// shorter than `range`, missing cells are treated as if absent (no
/// contribution). If `sum_range` is longer, extras are ignored.
/// This matches Excel's "anchor the top-left, ignore mismatched
/// shape beyond the criteria range's footprint" behavior in the
/// common case.
pub fn sumif(args: &[FnArg]) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let crit_range = match &args[0] {
        FnArg::Range(v) => v.as_slice(),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let crit = match &args[1] {
        FnArg::Scalar(v) => v,
        FnArg::Range(_) => return Value::Error(ErrorValue::Value),
    };
    let sum_range_owned;
    let sum_range: &[Value] = if args.len() == 3 {
        match &args[2] {
            FnArg::Range(v) => v.as_slice(),
            FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
        }
    } else {
        // Default: sum the criteria range itself.
        sum_range_owned = crit_range;
        sum_range_owned
    };

    let predicate = match build_predicate(crit) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };

    let mut total = 0.0_f64;
    for (c, s) in crit_range.iter().zip(sum_range.iter()) {
        if !predicate.matches(c) {
            continue;
        }
        match coerce_numeric(s) {
            NumericArg::Number(n) => total += n,
            NumericArg::Skip => {}
            // Excel: if a sum_range cell holds an error, the error
            // propagates. Match that.
            NumericArg::Error(e) => return Value::Error(e),
        }
    }
    match coercion::sanitize_f64(total) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `COUNTIF(range, criteria)` — count cells in `range` matching
/// `criteria`. Returns count as a `Number`. Error in criteria → that
/// error; error in a range cell → not counted (per Excel canon,
/// COUNTIF ignores Error cells, unlike SUMIF which propagates).
pub fn countif(args: &[FnArg]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let range = match &args[0] {
        FnArg::Range(v) => v.as_slice(),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let crit = match &args[1] {
        FnArg::Scalar(v) => v,
        FnArg::Range(_) => return Value::Error(ErrorValue::Value),
    };
    let predicate = match build_predicate(crit) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    let count = range.iter().filter(|v| predicate.matches(v)).count();
    Value::Number(count as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn n(x: f64) -> Value {
        Value::Number(x)
    }
    fn t(s: &str) -> Value {
        Value::Text(Arc::from(s))
    }
    fn r(vs: Vec<Value>) -> FnArg {
        FnArg::Range(vs)
    }
    fn s(v: Value) -> FnArg {
        FnArg::Scalar(v)
    }

    // ===== build_predicate =====

    #[test]
    fn predicate_number_eq() {
        let p = build_predicate(&n(5.0)).unwrap();
        assert!(p.matches(&n(5.0)));
        assert!(!p.matches(&n(6.0)));
        assert!(p.matches(&t("5"))); // numeric text matches
        assert!(!p.matches(&t("hello")));
    }

    #[test]
    fn predicate_text_gt() {
        let p = build_predicate(&t(">5")).unwrap();
        assert!(p.matches(&n(6.0)));
        assert!(!p.matches(&n(5.0)));
        assert!(!p.matches(&n(4.0)));
    }

    #[test]
    fn predicate_text_le() {
        let p = build_predicate(&t("<=10")).unwrap();
        assert!(p.matches(&n(10.0)));
        assert!(p.matches(&n(-5.0)));
        assert!(!p.matches(&n(11.0)));
    }

    #[test]
    fn predicate_text_ne() {
        let p = build_predicate(&t("<>foo")).unwrap();
        assert!(p.matches(&t("bar")));
        assert!(!p.matches(&t("foo")));
        assert!(!p.matches(&t("FOO"))); // case-insensitive equality → not-equal false
    }

    #[test]
    fn predicate_text_eq_case_insensitive() {
        let p = build_predicate(&t("Hello")).unwrap();
        assert!(p.matches(&t("hello")));
        assert!(p.matches(&t("HELLO")));
        assert!(!p.matches(&t("world")));
    }

    #[test]
    fn predicate_blank_equality() {
        let p = build_predicate(&t("")).unwrap();
        assert!(p.matches(&Value::Blank));
        assert!(p.matches(&t("")));
        assert!(!p.matches(&t("x")));
    }

    #[test]
    fn predicate_error_propagates() {
        let err = build_predicate(&Value::Error(ErrorValue::DivZero));
        assert!(matches!(err, Err(ErrorValue::DivZero)));
    }

    #[test]
    fn predicate_boolean() {
        let p = build_predicate(&Value::Boolean(true)).unwrap();
        assert!(p.matches(&Value::Boolean(true)));
        assert!(!p.matches(&Value::Boolean(false)));
    }

    // ===== SUMIF =====

    #[test]
    fn sumif_basic_numeric_criteria() {
        // Range: [1, 5, 5, 10]; criteria = 5 → matches 2 cells; sum = 10.
        let range = r(vec![n(1.0), n(5.0), n(5.0), n(10.0)]);
        let v = sumif(&[range, s(n(5.0))]);
        assert_eq!(v, n(10.0));
    }

    #[test]
    fn sumif_greater_than_criteria() {
        // Range: [1, 5, 10, 100]; criteria = ">5" → matches 10+100 = 110.
        let range = r(vec![n(1.0), n(5.0), n(10.0), n(100.0)]);
        let v = sumif(&[range, s(t(">5"))]);
        assert_eq!(v, n(110.0));
    }

    #[test]
    fn sumif_with_separate_sum_range() {
        // crit_range: [apple, banana, apple, cherry]
        // criteria: "apple"
        // sum_range: [1, 2, 3, 4]
        // Matches positions 0, 2 → sum 1+3 = 4.
        let crit = r(vec![t("apple"), t("banana"), t("apple"), t("cherry")]);
        let sums = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        let v = sumif(&[crit, s(t("apple")), sums]);
        assert_eq!(v, n(4.0));
    }

    #[test]
    fn sumif_text_criteria_skips_non_matching_strings() {
        // crit_range [1, foo, 2]; criteria ">0" — only numeric cells
        // that parse can compare. foo doesn't parse → doesn't match.
        let range = r(vec![n(1.0), t("foo"), n(2.0)]);
        let v = sumif(&[range, s(t(">0"))]);
        assert_eq!(v, n(3.0));
    }

    #[test]
    fn sumif_error_in_sum_range_propagates() {
        let crit = r(vec![n(1.0), n(1.0), n(1.0)]);
        let sums = r(vec![n(1.0), Value::Error(ErrorValue::DivZero), n(3.0)]);
        let v = sumif(&[crit, s(n(1.0)), sums]);
        assert_eq!(v, Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn sumif_blank_in_range_skipped() {
        // Blanks in the criteria range are checked against criteria.
        // Blanks in the sum range are skipped (no contribution).
        let crit = r(vec![n(1.0), n(1.0), n(1.0)]);
        let sums = r(vec![n(2.0), Value::Blank, n(5.0)]);
        let v = sumif(&[crit, s(n(1.0)), sums]);
        assert_eq!(v, n(7.0));
    }

    #[test]
    fn sumif_arity_errors() {
        assert_eq!(sumif(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(sumif(&[r(vec![n(1.0)])]), Value::Error(ErrorValue::Value));
        assert_eq!(
            sumif(&[r(vec![n(1.0)]), s(n(1.0)), s(n(1.0)), s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn sumif_wrong_arg_shape() {
        // arg[0] must be Range; if scalar → #VALUE!.
        assert_eq!(
            sumif(&[s(n(1.0)), s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
        // arg[1] must be Scalar; if range → #VALUE!.
        assert_eq!(
            sumif(&[r(vec![n(1.0)]), r(vec![n(1.0)])]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn sumif_empty_range() {
        let v = sumif(&[r(vec![]), s(n(1.0))]);
        assert_eq!(v, n(0.0));
    }

    #[test]
    fn sumif_error_in_criteria_propagates() {
        let range = r(vec![n(1.0)]);
        let v = sumif(&[range, s(Value::Error(ErrorValue::Num))]);
        assert_eq!(v, Value::Error(ErrorValue::Num));
    }

    // ===== COUNTIF =====

    #[test]
    fn countif_basic() {
        let range = r(vec![n(1.0), n(5.0), n(5.0), n(10.0)]);
        assert_eq!(countif(&[range, s(n(5.0))]), n(2.0));
    }

    #[test]
    fn countif_comparator_criteria() {
        let range = r(vec![n(1.0), n(5.0), n(10.0), n(100.0)]);
        assert_eq!(countif(&[range, s(t(">5"))]), n(2.0));
        let range = r(vec![n(1.0), n(5.0), n(10.0), n(100.0)]);
        assert_eq!(countif(&[range, s(t(">=5"))]), n(3.0));
        let range = r(vec![n(1.0), n(5.0), n(10.0), n(100.0)]);
        assert_eq!(countif(&[range, s(t("<>5"))]), n(3.0));
    }

    #[test]
    fn countif_text_criteria() {
        let range = r(vec![t("apple"), t("banana"), t("apple"), t("cherry")]);
        assert_eq!(countif(&[range, s(t("apple"))]), n(2.0));
    }

    #[test]
    fn countif_ignores_error_cells() {
        let range = r(vec![n(1.0), Value::Error(ErrorValue::DivZero), n(1.0)]);
        // Per Excel canon: COUNTIF does NOT propagate errors from
        // range cells (unlike SUMIF). Error cells are counted as
        // "doesn't match".
        assert_eq!(countif(&[range, s(n(1.0))]), n(2.0));
    }

    #[test]
    fn countif_arity_errors() {
        assert_eq!(countif(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(countif(&[r(vec![n(1.0)])]), Value::Error(ErrorValue::Value));
        assert_eq!(
            countif(&[r(vec![n(1.0)]), s(n(1.0)), s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn countif_empty_range() {
        assert_eq!(countif(&[r(vec![]), s(n(1.0))]), n(0.0));
    }

    #[test]
    fn countif_blank_criteria_matches_blanks() {
        let range = r(vec![n(1.0), Value::Blank, t(""), n(2.0)]);
        // Criteria = empty-string text → matches Blank + empty text → 2.
        assert_eq!(countif(&[range, s(t(""))]), n(2.0));
    }

    #[test]
    fn countif_error_in_criteria_propagates() {
        let range = r(vec![n(1.0)]);
        let v = countif(&[range, s(Value::Error(ErrorValue::Num))]);
        assert_eq!(v, Value::Error(ErrorValue::Num));
    }
}
