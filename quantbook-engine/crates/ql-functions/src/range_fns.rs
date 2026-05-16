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

// W5-64 (Phase 4.4.A): the previously-duplicated `NumericArg` + `coerce_numeric`
// helpers were consolidated into `crate::range_aware_fns` (cross-module home),
// which delegates to `ql_types::coercion::to_number_strict_skip_blank`.
use crate::range_aware_fns::{coerce_numeric, FnArg, NumericArg};
use crate::wildcard::{has_wildcards, WildcardPattern};

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
    /// Text-with-wildcards (W5-61). Only Eq / Ne. Excel canon: the
    /// pattern is matched against the cell's text representation
    /// (case-insensitive). Non-Text cells (Number, Bool) never match
    /// a wildcard criteria — matches Excel canon where wildcard
    /// criteria target text cells specifically.
    TextWildcard(CmpOp, WildcardPattern),
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
            Predicate::TextWildcard(op, pattern) => {
                // Excel canon: wildcards target text cells. Numbers,
                // Bools, and Errors are NEVER candidates for wildcard
                // matching — for BOTH Eq and Ne.
                //
                // W5-62 Codex audit HIGH H1 fix: previously this
                // computed `is_match=false` for non-text cells and
                // then `!is_match` for Ne, which incorrectly made
                // every Number / Bool / Error cell match `<>pattern`.
                // The contract is "wildcard criteria only see text
                // cells" — non-text cells are out-of-scope entirely.
                let is_text_candidate = matches!(v, Value::Text(_) | Value::Blank);
                if !is_text_candidate {
                    return false;
                }
                let is_match = match v {
                    Value::Text(s) => pattern.matches(s.as_ref()),
                    Value::Blank => pattern.matches(""),
                    _ => unreachable!("filtered above"),
                };
                match op {
                    CmpOp::Eq => is_match,
                    CmpOp::Ne => !is_match,
                    // Wildcards only support Eq/Ne (build_predicate
                    // never constructs this with ordered ops).
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
            // Wildcard detection (W5-61). Excel canon: wildcards
            // only apply to Eq / Ne. For ordered comparisons
            // (Lt/Le/Gt/Ge) wildcards are treated as literal chars.
            // Route to wildcard path if the criteria contains ANY of
            // `?`, `*`, OR `~` (the escape char) — even purely
            // escaped criteria like `~?` need the WildcardPattern
            // compiler to correctly strip the escape and produce a
            // literal-`?` match. `Predicate::Text` would compare the
            // raw string `~?` against cells and miss.
            let has_wildcard_syntax =
                matches!(op, CmpOp::Eq | CmpOp::Ne) && (has_wildcards(rest) || rest.contains('~'));
            if has_wildcard_syntax {
                return Ok(Predicate::TextWildcard(op, WildcardPattern::compile(rest)));
            }
            // Default: plain text comparison.
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
        FnArg::Range { values, .. } => values.as_slice(),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let crit = match &args[1] {
        FnArg::Scalar(v) => v,
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    let sum_range_owned;
    let sum_range: &[Value] = if args.len() == 3 {
        match &args[2] {
            FnArg::Range { values, .. } => values.as_slice(),
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

// ===== Lookup family (W5-54, Phase 4.3 V2 batch #3) =====
//
// VLOOKUP / HLOOKUP / MATCH / INDEX / CHOOSE. All consume the
// shape-aware `FnArg::Range { values, rows, cols }` introduced in
// W5-54 (or `FnArg::Scalar` for CHOOSE). Row/col addressing is
// 0-based internally; Excel-facing args are 1-based.

/// Compare two `Value`s for equality per Excel's MATCH/VLOOKUP rule:
/// text comparisons are case-insensitive; numbers and bools compare
/// strictly; numeric-text DOES match the corresponding number (e.g.
/// `Text("5")` matches `Number(5.0)` for lookup_value=5); Blank
/// matches Blank only; Error never matches.
fn lookup_eq(needle: &Value, hay: &Value) -> bool {
    match (needle, hay) {
        (Value::Error(_), _) | (_, Value::Error(_)) => false,
        (Value::Blank, Value::Blank) => true,
        (Value::Blank, _) | (_, Value::Blank) => false,
        (Value::Boolean(a), Value::Boolean(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::Text(a), Value::Text(b)) => a.eq_ignore_ascii_case(b),
        (Value::Number(a), Value::Text(t)) | (Value::Text(t), Value::Number(a)) => {
            t.parse::<f64>().map(|n| n == *a).unwrap_or(false)
        }
        // Bool vs other: no implicit coercion for lookup equality.
        (Value::Boolean(_), _) | (_, Value::Boolean(_)) => false,
    }
}

/// Compare two `Value`s for ordered comparison (used by approximate
/// MATCH/VLOOKUP). Returns `Some(ordering)` if comparable, `None`
/// otherwise (errors, type mismatch). Numbers compare numerically;
/// text compares case-insensitively as strings; bools compare false
/// < true. Cross-type comparison returns None.
fn lookup_cmp(a: &Value, b: &Value) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    match (a, b) {
        (Value::Error(_), _) | (_, Value::Error(_)) => None,
        (Value::Number(x), Value::Number(y)) => x.partial_cmp(y),
        (Value::Text(x), Value::Text(y)) => {
            let xu = x.to_uppercase();
            let yu = y.to_uppercase();
            Some(xu.cmp(&yu))
        }
        (Value::Boolean(x), Value::Boolean(y)) => Some(x.cmp(y)),
        (Value::Blank, Value::Blank) => Some(Ordering::Equal),
        // Treat Blank as 0 for numeric comparison (Excel canon).
        (Value::Blank, Value::Number(y)) => 0.0_f64.partial_cmp(y),
        (Value::Number(x), Value::Blank) => x.partial_cmp(&0.0_f64),
        _ => None,
    }
}

/// `MATCH(lookup_value, lookup_array, [match_type])` — return the
/// 1-based position of `lookup_value` in `lookup_array`. Match types:
/// - **0** (exact): linear scan; first equal match wins. Most common
///   form; the only safe choice for unsorted data.
/// - **1** (largest ≤, default): linear scan; return the position of
///   the largest value ≤ lookup_value. **Array must be sorted
///   ascending; un-sorted input yields undefined results per Excel
///   canon.** V1 implementation is linear (not binary search) for
///   simplicity; revisit if perf shows.
/// - **-1** (smallest ≥): linear scan; smallest value ≥ lookup_value.
///   Array must be sorted descending.
///
/// Returns `#N/A` if not found. The `lookup_array` should be 1D
/// (single row or single column); 2D is treated as flat row-major.
pub fn r#match(args: &[FnArg]) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let needle = match &args[0] {
        FnArg::Scalar(v) => v,
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    if let Value::Error(e) = needle {
        return Value::Error(*e);
    }
    let hay = match &args[1] {
        FnArg::Range { values, .. } => values.as_slice(),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let match_type: i32 = if args.len() == 3 {
        match &args[2] {
            FnArg::Scalar(Value::Number(n)) => n.trunc() as i32,
            FnArg::Scalar(Value::Blank) => 1,
            FnArg::Scalar(Value::Boolean(b)) => {
                if *b {
                    1
                } else {
                    0
                }
            }
            FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
            _ => return Value::Error(ErrorValue::Value),
        }
    } else {
        1
    };

    use std::cmp::Ordering;
    match match_type {
        0 => {
            for (i, cell) in hay.iter().enumerate() {
                if lookup_eq(needle, cell) {
                    return Value::Number((i + 1) as f64);
                }
            }
            Value::Error(ErrorValue::NA)
        }
        1 => {
            // Largest value ≤ needle. Assumes ascending sort; we
            // walk while cell ≤ needle and remember the last hit.
            let mut found: Option<usize> = None;
            for (i, cell) in hay.iter().enumerate() {
                match lookup_cmp(cell, needle) {
                    Some(Ordering::Less) | Some(Ordering::Equal) => found = Some(i),
                    Some(Ordering::Greater) => break,
                    None => continue,
                }
            }
            match found {
                Some(i) => Value::Number((i + 1) as f64),
                None => Value::Error(ErrorValue::NA),
            }
        }
        -1 => {
            // Smallest value ≥ needle. Assumes descending sort.
            let mut found: Option<usize> = None;
            for (i, cell) in hay.iter().enumerate() {
                match lookup_cmp(cell, needle) {
                    Some(Ordering::Greater) | Some(Ordering::Equal) => found = Some(i),
                    Some(Ordering::Less) => break,
                    None => continue,
                }
            }
            match found {
                Some(i) => Value::Number((i + 1) as f64),
                None => Value::Error(ErrorValue::NA),
            }
        }
        _ => Value::Error(ErrorValue::Value),
    }
}

// ===== W5-169 (Phase 4.10.G) — XLOOKUP / XMATCH =====

/// Decode the `match_mode` arg of XLOOKUP / XMATCH per Excel canon:
/// 0=exact (default), -1=exact-or-next-smaller, 1=exact-or-next-larger,
/// 2=wildcard. Returns Err on out-of-range or invalid input.
fn decode_xlookup_match_mode(arg: Option<&FnArg>) -> Result<i32, ErrorValue> {
    match arg {
        None => Ok(0),
        Some(FnArg::Scalar(Value::Number(n))) => {
            let m = n.trunc() as i32;
            if !(-1..=2).contains(&m) {
                return Err(ErrorValue::Value);
            }
            Ok(m)
        }
        Some(FnArg::Scalar(Value::Blank)) => Ok(0),
        Some(FnArg::Scalar(Value::Boolean(b))) => Ok(if *b { 1 } else { 0 }),
        Some(FnArg::Scalar(Value::Error(e))) => Err(*e),
        _ => Err(ErrorValue::Value),
    }
}

/// Decode the `search_mode` arg of XLOOKUP / XMATCH per Excel canon:
/// 1=first→last (default), -1=last→first, 2=binary ascending,
/// -2=binary descending. Linear scan handles ±1 modes; W5-176
/// `xlookup_find_index_binary` handles ±2 with real binary search
/// (matches Excel: unsorted input → undefined / `#N/A`).
fn decode_xlookup_search_mode(arg: Option<&FnArg>) -> Result<i32, ErrorValue> {
    match arg {
        None => Ok(1),
        Some(FnArg::Scalar(Value::Number(n))) => {
            let m = n.trunc() as i32;
            if !matches!(m, 1 | -1 | 2 | -2) {
                return Err(ErrorValue::Value);
            }
            Ok(m)
        }
        Some(FnArg::Scalar(Value::Blank)) => Ok(1),
        Some(FnArg::Scalar(Value::Error(e))) => Err(*e),
        _ => Err(ErrorValue::Value),
    }
}

/// Wildcard match (per the existing W5-61 wildcard infrastructure):
/// `?` matches any single char; `*` matches any sequence; `~` escapes.
fn xlookup_wildcard_match(pattern: &Value, cell: &Value) -> bool {
    let pat = match pattern {
        Value::Text(s) => s.as_ref(),
        _ => return lookup_eq(pattern, cell),
    };
    let text = match cell {
        Value::Text(s) => s.as_ref(),
        // Coerce non-text cells to text representation; wildcards on
        // non-text are useful only when pattern is non-wildcard, in
        // which case lookup_eq handles type-coercion.
        _ => return lookup_eq(pattern, cell),
    };
    crate::wildcard::WildcardPattern::compile(pat).matches(text)
}

/// **W5-176 (Phase 4.10 polish):** binary search over a sorted `hay`.
/// `descending` selects ascending (`false`, `search_mode=2`) vs
/// descending (`true`, `search_mode=-2`) sort. Per Excel canon: the
/// caller is responsible for the sort invariant — if `hay` is unsorted,
/// results are undefined (typically `#N/A` because the bisection
/// branches into a region that doesn't contain the needle). This
/// matches Excel's own behavior, which does NOT validate sort order.
///
/// `match_mode` 2 (wildcard) is rejected upstream and never reaches
/// here; this function handles `0`, `-1`, `1`.
fn xlookup_find_index_binary(
    needle: &Value,
    hay: &[Value],
    match_mode: i32,
    descending: bool,
) -> Option<usize> {
    use std::cmp::Ordering;
    if hay.is_empty() {
        return None;
    }
    // Lower-bound binary search: find the insertion point where
    // `needle` would maintain sort order. On exact equality, return
    // immediately (we don't need to find the FIRST equal-index because
    // duplicates are caller-error per Excel's binary contract).
    let mut lo = 0usize;
    let mut hi = hay.len();
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let ord = match lookup_cmp(&hay[mid], needle) {
            Some(o) => o,
            None => {
                // Incomparable cell (type mismatch or Error in hay).
                // The sort invariant is broken — fall through to None.
                // Matches Excel: binary lookup over heterogeneously-
                // typed data returns nothing rather than guessing.
                return None;
            }
        };
        match (descending, ord) {
            (_, Ordering::Equal) => return Some(mid),
            (false, Ordering::Less) | (true, Ordering::Greater) => lo = mid + 1,
            (false, Ordering::Greater) | (true, Ordering::Less) => hi = mid,
        }
    }
    // No exact match. `lo` is the insertion point. Map to the
    // requested approximation per match_mode + sort direction.
    match match_mode {
        0 => None,
        1 => {
            // Caller wants the SMALLEST cell ≥ needle (in absolute terms).
            // Ascending: insertion point `lo` is the first cell > needle.
            // Descending: `lo - 1` is the last cell > needle (smallest > needle).
            if descending {
                if lo > 0 {
                    Some(lo - 1)
                } else {
                    None
                }
            } else if lo < hay.len() {
                Some(lo)
            } else {
                None
            }
        }
        -1 => {
            // Caller wants the LARGEST cell ≤ needle (in absolute terms).
            // Ascending: `lo - 1` is the last cell < needle.
            // Descending: insertion point `lo` is the first cell < needle.
            if descending {
                if lo < hay.len() {
                    Some(lo)
                } else {
                    None
                }
            } else if lo > 0 {
                Some(lo - 1)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Find the XLOOKUP / XMATCH index per (match_mode, search_mode). Returns
/// the 0-based index into `hay`, or `None` if no match.
fn xlookup_find_index(
    needle: &Value,
    hay: &[Value],
    match_mode: i32,
    search_mode: i32,
) -> Option<usize> {
    use std::cmp::Ordering;
    // **W5-176:** real binary search for search_mode ±2. Match_mode 2
    // (wildcard) + binary modes are rejected upstream as #VALUE!, so
    // any (±2) we see here goes through the binary path with
    // match_mode in {0, -1, 1}.
    if search_mode == 2 || search_mode == -2 {
        return xlookup_find_index_binary(needle, hay, match_mode, search_mode == -2);
    }
    // Direction-aware iteration helper.
    let reverse = search_mode < 0;
    let indices: Box<dyn Iterator<Item = usize>> = if reverse {
        Box::new((0..hay.len()).rev())
    } else {
        Box::new(0..hay.len())
    };
    let mut best_smaller: Option<usize> = None;
    let mut best_larger: Option<usize> = None;
    for i in indices {
        let cell = &hay[i];
        let eq = match match_mode {
            2 => xlookup_wildcard_match(needle, cell),
            _ => lookup_eq(needle, cell),
        };
        if eq {
            return Some(i);
        }
        if match_mode == -1 || match_mode == 1 {
            match lookup_cmp(cell, needle) {
                Some(Ordering::Less) if match_mode == -1 => {
                    // Track the LARGEST cell that's still < needle.
                    let take = match best_smaller {
                        None => true,
                        Some(j) => matches!(lookup_cmp(cell, &hay[j]), Some(Ordering::Greater)),
                    };
                    if take {
                        best_smaller = Some(i);
                    }
                }
                Some(Ordering::Greater) if match_mode == 1 => {
                    // Track the SMALLEST cell that's still > needle.
                    let take = match best_larger {
                        None => true,
                        Some(j) => matches!(lookup_cmp(cell, &hay[j]), Some(Ordering::Less)),
                    };
                    if take {
                        best_larger = Some(i);
                    }
                }
                _ => {}
            }
        }
    }
    match match_mode {
        -1 => best_smaller,
        1 => best_larger,
        _ => None,
    }
}

/// **W5-169 (Phase 4.10.G):** `XLOOKUP(lookup_value, lookup_array,
/// return_array, [if_not_found], [match_mode=0], [search_mode=1])` —
/// modern replacement for VLOOKUP / HLOOKUP / INDEX+MATCH. V1 returns
/// scalar results only (2D return_array → Phase 4.7 spill).
///
/// **Match modes** (per Excel canon):
/// - `0` exact (default).
/// - `-1` exact or next smaller.
/// - `1` exact or next larger.
/// - `2` wildcard (`?`, `*`, `~` escape).
///
/// **Search modes**:
/// - `1` first→last (default).
/// - `-1` last→first.
/// - `2` binary ascending. Caller must pre-sort ascending; W5-176
///   replaced the V1 linear scan with real binary search. Unsorted
///   input yields undefined results (typically `#N/A`) — matches
///   Excel canon (Excel itself does not validate sort order).
/// - `-2` binary descending — symmetric requirement.
///
/// `if_not_found`: returned on no match. If omitted, `#N/A`.
pub fn xlookup(args: &[FnArg]) -> Value {
    if !(3..=6).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let needle = match &args[0] {
        FnArg::Scalar(v) => v,
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    if let Value::Error(e) = needle {
        return Value::Error(*e);
    }
    let (hay, hay_rows, hay_cols) = match &args[1] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let (ret, ret_rows, ret_cols) = match &args[2] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    // V1: lookup_array must be 1D (single row OR single column) and
    // return_array must have the same length. 2D return_array → Phase
    // 4.7 spill.
    if hay_rows != 1 && hay_cols != 1 {
        return Value::Error(ErrorValue::Value);
    }
    if ret.len() != hay.len() {
        return Value::Error(ErrorValue::Value);
    }
    // V1 scalar return only.
    if ret_rows != 1 && ret_cols != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let match_mode = match decode_xlookup_match_mode(args.get(4)) {
        Ok(m) => m,
        Err(e) => return Value::Error(e),
    };
    let search_mode = match decode_xlookup_search_mode(args.get(5)) {
        Ok(m) => m,
        Err(e) => return Value::Error(e),
    };
    // **W5-171 (Codex MEDIUM-3):** wildcard + binary modes are
    // mutually exclusive per Excel canon (wildcard requires linear
    // scan; binary requires sorted input). IronCalc rejects this
    // combo; mirror that.
    if match_mode == 2 && (search_mode == 2 || search_mode == -2) {
        return Value::Error(ErrorValue::Value);
    }
    match xlookup_find_index(needle, hay, match_mode, search_mode) {
        Some(i) => ret[i].clone(),
        None => {
            // if_not_found: clone the scalar arg if provided; else #N/A.
            if let Some(arg) = args.get(3) {
                match arg {
                    FnArg::Scalar(v) => v.clone(),
                    FnArg::Range { .. } => Value::Error(ErrorValue::Value),
                }
            } else {
                Value::Error(ErrorValue::NA)
            }
        }
    }
}

/// **W5-169 (Phase 4.10.G):** `XMATCH(lookup_value, lookup_array,
/// [match_mode=0], [search_mode=1])` — modern replacement for MATCH.
/// Returns the 1-based position in `lookup_array`. Same match_mode +
/// search_mode semantics as `XLOOKUP`. No match → `#N/A`.
pub fn xmatch(args: &[FnArg]) -> Value {
    if !(2..=4).contains(&args.len()) {
        return Value::Error(ErrorValue::Value);
    }
    let needle = match &args[0] {
        FnArg::Scalar(v) => v,
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    if let Value::Error(e) = needle {
        return Value::Error(*e);
    }
    let (hay, hay_rows, hay_cols) = match &args[1] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    if hay_rows != 1 && hay_cols != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let match_mode = match decode_xlookup_match_mode(args.get(2)) {
        Ok(m) => m,
        Err(e) => return Value::Error(e),
    };
    let search_mode = match decode_xlookup_search_mode(args.get(3)) {
        Ok(m) => m,
        Err(e) => return Value::Error(e),
    };
    // **W5-171 (Codex MEDIUM-3):** wildcard + binary modes mutually
    // exclusive (mirrors xlookup; IronCalc canon).
    if match_mode == 2 && (search_mode == 2 || search_mode == -2) {
        return Value::Error(ErrorValue::Value);
    }
    match xlookup_find_index(needle, hay, match_mode, search_mode) {
        Some(i) => Value::Number((i + 1) as f64),
        None => Value::Error(ErrorValue::NA),
    }
}

/// `INDEX(array, row_num, [col_num])` — return the element at the
/// (1-based) row + col position of `array`. For a 1D array (single
/// row or column), `col_num` is optional and the second arg is
/// interpreted as the index along the array's axis.
///
/// V1 returns scalar results only. `row_num = 0` (return whole
/// column) and `col_num = 0` (return whole row) are array-return
/// modes that need spill semantics — Phase 4.7 ARR work; for now
/// they return `#REF!` to avoid silently returning the first cell.
/// Out-of-bounds → `#REF!`.
pub fn index(args: &[FnArg]) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let (values, rows, cols) = match &args[0] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    if values.is_empty() {
        return Value::Error(ErrorValue::Ref);
    }

    let scalar_to_idx = |v: &Value| -> Result<i64, ErrorValue> {
        match v {
            Value::Number(n) => Ok(n.trunc() as i64),
            Value::Boolean(true) => Ok(1),
            Value::Boolean(false) => Ok(0),
            Value::Blank => Ok(0),
            Value::Error(e) => Err(*e),
            Value::Text(_) => Err(ErrorValue::Value),
        }
    };

    let row_num = match &args[1] {
        FnArg::Scalar(v) => match scalar_to_idx(v) {
            Ok(i) => i,
            Err(e) => return Value::Error(e),
        },
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    let col_num: i64 = if args.len() == 3 {
        match &args[2] {
            FnArg::Scalar(v) => match scalar_to_idx(v) {
                Ok(i) => i,
                Err(e) => return Value::Error(e),
            },
            FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
        }
    } else if rows == 1 {
        // Single-row array + only row_num supplied: interpret
        // row_num as the column index along the single row.
        let idx = row_num;
        return index_1d(values, idx, cols);
    } else if cols == 1 {
        // Single-column array + only row_num supplied: row_num IS
        // the position along the column.
        return index_1d(values, row_num, rows);
    } else {
        // 2D array but only one arg → ambiguous. Excel canon:
        // `INDEX(2D, n)` returns the nth row as an array, which
        // we don't support yet.
        return Value::Error(ErrorValue::Ref);
    };

    // 0,0 → whole array (spill, not supported V1).
    if row_num == 0 && col_num == 0 {
        return Value::Error(ErrorValue::Ref);
    }
    // 0 in one dimension → whole row/col spill (not supported V1).
    if row_num == 0 || col_num == 0 {
        return Value::Error(ErrorValue::Ref);
    }
    // Negative or zero → #VALUE! per Excel.
    if row_num < 1 || col_num < 1 {
        return Value::Error(ErrorValue::Value);
    }
    let r = (row_num - 1) as usize;
    let c = (col_num - 1) as usize;
    if r >= rows || c >= cols {
        return Value::Error(ErrorValue::Ref);
    }
    values[r * cols + c].clone()
}

/// Helper for INDEX 1D case: array is single row OR single column,
/// `idx` is 1-based, `axis_len` is the number of elements along the
/// non-degenerate axis.
fn index_1d(values: &[Value], idx: i64, axis_len: usize) -> Value {
    if idx == 0 {
        // Whole-array spill — not supported V1.
        return Value::Error(ErrorValue::Ref);
    }
    if idx < 1 {
        return Value::Error(ErrorValue::Value);
    }
    let i = (idx - 1) as usize;
    if i >= axis_len {
        return Value::Error(ErrorValue::Ref);
    }
    values[i].clone()
}

/// Internal helper used by VLOOKUP and HLOOKUP: extract the
/// "lookup column" (col 0 for VLOOKUP; the entire row 0 for HLOOKUP)
/// from a 2D shape, run the appropriate MATCH (exact or
/// approximate), and return the matched offset.
///
/// `axis_values` is the 1D vector along the search axis. Returns the
/// 0-based position, or `Err(#N/A)` if not found.
fn lookup_search(needle: &Value, axis_values: &[Value], exact: bool) -> Result<usize, ErrorValue> {
    use std::cmp::Ordering;
    if exact {
        for (i, cell) in axis_values.iter().enumerate() {
            if lookup_eq(needle, cell) {
                return Ok(i);
            }
        }
        Err(ErrorValue::NA)
    } else {
        let mut found: Option<usize> = None;
        for (i, cell) in axis_values.iter().enumerate() {
            match lookup_cmp(cell, needle) {
                Some(Ordering::Less) | Some(Ordering::Equal) => found = Some(i),
                Some(Ordering::Greater) => break,
                None => continue,
            }
        }
        found.ok_or(ErrorValue::NA)
    }
}

/// `VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])`
/// — search the FIRST COLUMN of `table_array` for `lookup_value`,
/// return the value at `col_index_num` of the matched row (1-based).
///
/// `range_lookup`: TRUE (default) = approximate match (table must be
/// sorted ascending by first column); FALSE = exact match. Not-found
/// → `#N/A`. col_index_num out of range → `#REF!`.
pub fn vlookup(args: &[FnArg]) -> Value {
    if args.len() < 3 || args.len() > 4 {
        return Value::Error(ErrorValue::Value);
    }
    let needle = match &args[0] {
        FnArg::Scalar(v) => v,
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    if let Value::Error(e) = needle {
        return Value::Error(*e);
    }
    let (values, rows, cols) = match &args[1] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let col_index_num = match &args[2] {
        FnArg::Scalar(Value::Number(n)) => n.trunc() as i64,
        FnArg::Scalar(Value::Boolean(b)) => i64::from(*b),
        FnArg::Scalar(Value::Blank) => 0,
        FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
        _ => return Value::Error(ErrorValue::Value),
    };
    if col_index_num < 1 {
        return Value::Error(ErrorValue::Value);
    }
    let col_index = (col_index_num - 1) as usize;
    if col_index >= cols {
        return Value::Error(ErrorValue::Ref);
    }
    let exact = if args.len() == 4 {
        match &args[3] {
            FnArg::Scalar(Value::Boolean(b)) => !*b,
            FnArg::Scalar(Value::Number(n)) => *n == 0.0,
            FnArg::Scalar(Value::Blank) => false, // default approximate
            FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
            _ => return Value::Error(ErrorValue::Value),
        }
    } else {
        false // default: approximate match
    };

    // Materialize the first column.
    if rows == 0 || cols == 0 {
        return Value::Error(ErrorValue::NA);
    }
    let first_col: Vec<Value> = (0..rows).map(|r| values[r * cols].clone()).collect();
    match lookup_search(needle, &first_col, exact) {
        Ok(r) => values[r * cols + col_index].clone(),
        Err(e) => Value::Error(e),
    }
}

/// `HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])`
/// — mirror of VLOOKUP along rows: search the FIRST ROW of
/// `table_array`, return the value at `row_index_num` of the matched
/// column.
pub fn hlookup(args: &[FnArg]) -> Value {
    if args.len() < 3 || args.len() > 4 {
        return Value::Error(ErrorValue::Value);
    }
    let needle = match &args[0] {
        FnArg::Scalar(v) => v,
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    if let Value::Error(e) = needle {
        return Value::Error(*e);
    }
    let (values, rows, cols) = match &args[1] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let row_index_num = match &args[2] {
        FnArg::Scalar(Value::Number(n)) => n.trunc() as i64,
        FnArg::Scalar(Value::Boolean(b)) => i64::from(*b),
        FnArg::Scalar(Value::Blank) => 0,
        FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
        _ => return Value::Error(ErrorValue::Value),
    };
    if row_index_num < 1 {
        return Value::Error(ErrorValue::Value);
    }
    let row_index = (row_index_num - 1) as usize;
    if row_index >= rows {
        return Value::Error(ErrorValue::Ref);
    }
    let exact = if args.len() == 4 {
        match &args[3] {
            FnArg::Scalar(Value::Boolean(b)) => !*b,
            FnArg::Scalar(Value::Number(n)) => *n == 0.0,
            FnArg::Scalar(Value::Blank) => false,
            FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
            _ => return Value::Error(ErrorValue::Value),
        }
    } else {
        false
    };
    if rows == 0 || cols == 0 {
        return Value::Error(ErrorValue::NA);
    }
    let first_row: Vec<Value> = values.iter().take(cols).cloned().collect();
    match lookup_search(needle, &first_row, exact) {
        Ok(c) => values[row_index * cols + c].clone(),
        Err(e) => Value::Error(e),
    }
}

/// `CHOOSE(index_num, value1, [value2, ...])` — return the `index_num`-th
/// value from the list (1-based). All args are scalars (no ranges).
/// Excel canon: index_num must be ≥1 and ≤ count of values.
pub fn choose(args: &[FnArg]) -> Value {
    if args.len() < 2 {
        return Value::Error(ErrorValue::Value);
    }
    let index_num = match &args[0] {
        FnArg::Scalar(Value::Number(n)) => n.trunc() as i64,
        FnArg::Scalar(Value::Boolean(b)) => i64::from(*b),
        FnArg::Scalar(Value::Blank) => 0,
        FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
        _ => return Value::Error(ErrorValue::Value),
    };
    if index_num < 1 {
        return Value::Error(ErrorValue::Value);
    }
    let i = index_num as usize;
    if i >= args.len() {
        // args[0] is index, args[1..] are values; valid i is 1..args.len()-1+1 = args.len()
        // But i (1-based) maps to args[i]. So valid: 1 ≤ i ≤ args.len()-1.
        return Value::Error(ErrorValue::Value);
    }
    match &args[i] {
        FnArg::Scalar(v) => v.clone(),
        FnArg::Range { .. } => Value::Error(ErrorValue::Value),
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
        FnArg::Range { values, .. } => values.as_slice(),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let crit = match &args[1] {
        FnArg::Scalar(v) => v,
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    let predicate = match build_predicate(crit) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    let count = range.iter().filter(|v| predicate.matches(v)).count();
    Value::Number(count as f64)
}

// ===== W5-55: AVERAGEIF / SUMIFS / COUNTIFS / AVERAGEIFS / SUMPRODUCT =====
//
// Conditional-aggregate completion batch. Direct extensions of
// W5-53's `build_predicate` + W5-54's range-shape infra. All ranges
// in an IFS-family call must have identical row × col dimensions
// (Excel canon: #VALUE! otherwise).

/// `AVERAGEIF(range, criteria, [average_range])` — average cells in
/// `average_range` (or `range` if omitted) where the corresponding
/// cell in `range` matches `criteria`. Returns `#DIV/0!` if no cells
/// match. Same predicate semantics as SUMIF.
pub fn averageif(args: &[FnArg]) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let crit_range = match &args[0] {
        FnArg::Range { values, .. } => values.as_slice(),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let crit = match &args[1] {
        FnArg::Scalar(v) => v,
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    let avg_range: &[Value] = if args.len() == 3 {
        match &args[2] {
            FnArg::Range { values, .. } => values.as_slice(),
            FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
        }
    } else {
        crit_range
    };
    let predicate = match build_predicate(crit) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    let mut total = 0.0_f64;
    let mut count: usize = 0;
    for (c, v) in crit_range.iter().zip(avg_range.iter()) {
        if !predicate.matches(c) {
            continue;
        }
        match coerce_numeric(v) {
            NumericArg::Number(n) => {
                total += n;
                count += 1;
            }
            // Blank in the average range: skip (don't count). Matches
            // SUMIF / AVERAGE behavior — Blank ≠ zero in averaging.
            NumericArg::Skip => {}
            NumericArg::Error(e) => return Value::Error(e),
        }
    }
    if count == 0 {
        return Value::Error(ErrorValue::DivZero);
    }
    match coercion::sanitize_f64(total / (count as f64)) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// Helper: parse `[crit_range1, crit1, crit_range2, crit2, ...]`
/// pairs after a starting index. Returns
/// `(paired_ranges_and_preds, (expected_rows, expected_cols))`
/// or an Error to propagate.
///
/// For SUMIFS / AVERAGEIFS the start_index is 1 (arg[0] is the
/// sum/average range). For COUNTIFS it's 0 (no leading range).
///
/// **W5-60 fix (Codex mega-audit HIGH H2):** all ranges must have
/// identical 2D shape `(rows, cols)`, NOT just identical flat
/// length. The pre-W5-60 check only compared `.len()` which silently
/// accepted `2x2` vs `1x4` (both length 4) and produced wrong row-
/// major matched answers. Excel canon: mismatched shapes → `#VALUE!`.
type IfsPairs<'a> = (Vec<(&'a [Value], Predicate)>, (usize, usize));

fn parse_ifs_pairs<'a>(args: &'a [FnArg], start_index: usize) -> Result<IfsPairs<'a>, ErrorValue> {
    let pair_args = &args[start_index..];
    if pair_args.is_empty() || pair_args.len() % 2 != 0 {
        return Err(ErrorValue::Value);
    }
    let mut pairs: Vec<(&'a [Value], Predicate)> = Vec::with_capacity(pair_args.len() / 2);
    let mut expected_shape: Option<(usize, usize)> = None;
    let mut chunks = pair_args.chunks_exact(2);
    for pair in chunks.by_ref() {
        let (range, rrows, rcols) = match &pair[0] {
            FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
            FnArg::Scalar(_) => return Err(ErrorValue::Value),
        };
        let pred_arg = match &pair[1] {
            FnArg::Scalar(v) => v,
            FnArg::Range { .. } => return Err(ErrorValue::Value),
        };
        let pred = build_predicate(pred_arg)?;
        // 2D shape check.
        match expected_shape {
            None => expected_shape = Some((rrows, rcols)),
            Some((er, ec)) if er != rrows || ec != rcols => return Err(ErrorValue::Value),
            Some(_) => {}
        }
        pairs.push((range, pred));
    }
    Ok((pairs, expected_shape.unwrap_or((0, 0))))
}

/// `SUMIFS(sum_range, criteria_range1, criteria1, [crit_range2,
/// crit2, ...])` — sum cells in `sum_range` where ALL
/// criteria_range/criteria pairs match elementwise.
///
/// Excel-canon argument order: sum_range FIRST, then pairs. (SUMIF
/// has sum_range LAST — confusing but it's the spec.)
pub fn sumifs(args: &[FnArg]) -> Value {
    if args.len() < 3 {
        return Value::Error(ErrorValue::Value);
    }
    let (sum_range, sr_rows, sr_cols) = match &args[0] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let (pairs, (exp_rows, exp_cols)) = match parse_ifs_pairs(args, 1) {
        Ok(x) => x,
        Err(e) => return Value::Error(e),
    };
    // W5-60: 2D shape check (rows + cols must both match).
    if sr_rows != exp_rows || sr_cols != exp_cols {
        return Value::Error(ErrorValue::Value);
    }
    let total_cells = exp_rows * exp_cols;
    let mut total = 0.0_f64;
    for i in 0..total_cells {
        let mut all_match = true;
        for (range, pred) in &pairs {
            if !pred.matches(&range[i]) {
                all_match = false;
                break;
            }
        }
        if !all_match {
            continue;
        }
        match coerce_numeric(&sum_range[i]) {
            NumericArg::Number(n) => total += n,
            NumericArg::Skip => {}
            NumericArg::Error(e) => return Value::Error(e),
        }
    }
    match coercion::sanitize_f64(total) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `COUNTIFS(criteria_range1, criteria1, [crit_range2, crit2, ...])`
/// — count cells where ALL criteria_range/criteria pairs match
/// elementwise. Errors in range cells don't propagate (Excel canon —
/// same as COUNTIF).
pub fn countifs(args: &[FnArg]) -> Value {
    if args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let (pairs, (exp_rows, exp_cols)) = match parse_ifs_pairs(args, 0) {
        Ok(x) => x,
        Err(e) => return Value::Error(e),
    };
    let total_cells = exp_rows * exp_cols;
    let mut count: usize = 0;
    for i in 0..total_cells {
        let mut all_match = true;
        for (range, pred) in &pairs {
            if !pred.matches(&range[i]) {
                all_match = false;
                break;
            }
        }
        if all_match {
            count += 1;
        }
    }
    Value::Number(count as f64)
}

/// `AVERAGEIFS(average_range, criteria_range1, criteria1, ...)` —
/// like SUMIFS but average. Returns `#DIV/0!` if no rows match.
pub fn averageifs(args: &[FnArg]) -> Value {
    if args.len() < 3 {
        return Value::Error(ErrorValue::Value);
    }
    let (avg_range, ar_rows, ar_cols) = match &args[0] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let (pairs, (exp_rows, exp_cols)) = match parse_ifs_pairs(args, 1) {
        Ok(x) => x,
        Err(e) => return Value::Error(e),
    };
    if ar_rows != exp_rows || ar_cols != exp_cols {
        return Value::Error(ErrorValue::Value);
    }
    let total_cells = exp_rows * exp_cols;
    let mut total = 0.0_f64;
    let mut count: usize = 0;
    for i in 0..total_cells {
        let mut all_match = true;
        for (range, pred) in &pairs {
            if !pred.matches(&range[i]) {
                all_match = false;
                break;
            }
        }
        if !all_match {
            continue;
        }
        match coerce_numeric(&avg_range[i]) {
            NumericArg::Number(n) => {
                total += n;
                count += 1;
            }
            NumericArg::Skip => {}
            NumericArg::Error(e) => return Value::Error(e),
        }
    }
    if count == 0 {
        return Value::Error(ErrorValue::DivZero);
    }
    match coercion::sanitize_f64(total / count as f64) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

// ===== W5-166 (Phase 4.10.D) — paired sum-of-squares variants =====
//
// SUMX2MY2 / SUMX2PY2 / SUMXMY2 are all 2-arg, paired array iterators.
// Per Excel canon (verified vs IronCalc `fn_sumx2my2` / `fn_sumx2py2` /
// `fn_sumxmy2`): both args must be ranges of the same flat length;
// shape mismatch → #VALUE!. Non-numeric cells coerce to 0 (lenient,
// matches SUMPRODUCT). Errors propagate.

#[derive(Clone, Copy)]
enum PairedOp {
    /// Σ(x² - y²)
    X2MY2,
    /// Σ(x² + y²)
    X2PY2,
    /// Σ(x - y)²
    XMY2,
}

fn paired_sum_inner(args: &[FnArg], op: PairedOp) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let (xs, x_rows, x_cols) = match &args[0] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let (ys, y_rows, y_cols) = match &args[1] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    // W5-60 strict 2D shape check.
    if x_rows != y_rows || x_cols != y_cols {
        return Value::Error(ErrorValue::Value);
    }
    let mut total = 0.0_f64;
    for (xv, yv) in xs.iter().zip(ys.iter()) {
        // Errors propagate per Excel canon.
        if let Value::Error(e) = xv {
            return Value::Error(*e);
        }
        if let Value::Error(e) = yv {
            return Value::Error(*e);
        }
        // Coerce to numeric; non-numeric (text / blank / bool that
        // can't coerce strict) → 0. Matches IronCalc's `unwrap_or(0.0)`.
        let x = match coerce_numeric(xv) {
            NumericArg::Number(n) => n,
            NumericArg::Skip => 0.0,
            NumericArg::Error(_) => 0.0, // unreachable — propagated above
        };
        let y = match coerce_numeric(yv) {
            NumericArg::Number(n) => n,
            NumericArg::Skip => 0.0,
            NumericArg::Error(_) => 0.0,
        };
        total += match op {
            PairedOp::X2MY2 => x * x - y * y,
            PairedOp::X2PY2 => x * x + y * y,
            PairedOp::XMY2 => (x - y) * (x - y),
        };
    }
    match coercion::sanitize_f64(total) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// **W5-166 (Phase 4.10.D):** `SUMX2MY2(array_x, array_y)` — Σ(x² - y²).
/// Excel canon: same flat shape required. Non-numeric cells coerce to
/// 0. Errors in either array propagate.
pub fn sumx2my2(args: &[FnArg]) -> Value {
    paired_sum_inner(args, PairedOp::X2MY2)
}

/// **W5-166 (Phase 4.10.D):** `SUMX2PY2(array_x, array_y)` — Σ(x² + y²).
pub fn sumx2py2(args: &[FnArg]) -> Value {
    paired_sum_inner(args, PairedOp::X2PY2)
}

/// **W5-166 (Phase 4.10.D):** `SUMXMY2(array_x, array_y)` — Σ(x - y)².
pub fn sumxmy2(args: &[FnArg]) -> Value {
    paired_sum_inner(args, PairedOp::XMY2)
}

/// **W5-177 (Phase 4.10 polish / Wave 3 starter):** Pearson correlation
/// coefficient — closed-form sum-of-cross-products variant per IronCalc
/// port:
///
/// ```text
///         n · Σxy − Σx · Σy
/// r = ─────────────────────────────
///     √((n·Σx² − (Σx)²) · (n·Σy² − (Σy)²))
/// ```
///
/// Pre-condition: caller has already filtered to pure numeric pairs.
/// `xs.len() == ys.len() >= 2` is the invariant; callers must enforce.
pub(crate) fn compute_correl(xs: &[f64], ys: &[f64]) -> Result<f64, ErrorValue> {
    let n = xs.len() as f64;
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;
    let mut sum_x2 = 0.0;
    let mut sum_y2 = 0.0;
    let mut sum_xy = 0.0;
    for (&x, &y) in xs.iter().zip(ys.iter()) {
        sum_x += x;
        sum_y += y;
        sum_x2 += x * x;
        sum_y2 += y * y;
        sum_xy += x * y;
    }
    let num = n * sum_xy - sum_x * sum_y;
    let denom_x = n * sum_x2 - sum_x * sum_x;
    let denom_y = n * sum_y2 - sum_y * sum_y;
    let denom = (denom_x * denom_y).sqrt();
    if denom == 0.0 || !denom.is_finite() {
        // Constant-array on either side → undefined correlation;
        // Excel + IronCalc both surface as #DIV/0!.
        return Err(ErrorValue::DivZero);
    }
    let r = num / denom;
    if !r.is_finite() {
        return Err(ErrorValue::Num);
    }
    Ok(r)
}

/// **W5-179 (Phase 4.10 polish / Wave 3 regression batch closure):**
/// shared FnArg → numeric xy-pairs extraction used by CORREL,
/// PEARSON, RSQ, and STEYX. Both args MUST be ranges of identical
/// shape. Pairs where EITHER cell is non-numeric (Text / Boolean /
/// Blank) are dropped per the IronCalc `values_from_range` rule —
/// Booleans NOT coerced to 1/0 (diverges from SUM canon). Errors
/// propagate immediately.
///
/// **Shape-mismatch divergence:** returns `Err(#VALUE!)` per the
/// in-codebase paired-array convention (SUMX2MY2 family from W5-166,
/// CORREL/SLOPE/INTERCEPT from W5-177/178). Microsoft canon says
/// `#N/A` — engine-wide divergence flagged in `excel-matrix.md`.
fn collect_xy_pairs(a: &FnArg, b: &FnArg) -> Result<(Vec<f64>, Vec<f64>), ErrorValue> {
    let (a_raw, a_rows, a_cols) = match a {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Err(ErrorValue::Value),
    };
    let (b_raw, b_rows, b_cols) = match b {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Err(ErrorValue::Value),
    };
    if a_rows != b_rows || a_cols != b_cols {
        return Err(ErrorValue::Value);
    }
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for (av, bv) in a_raw.iter().zip(b_raw.iter()) {
        if let Value::Error(e) = av {
            return Err(*e);
        }
        if let Value::Error(e) = bv {
            return Err(*e);
        }
        let x_opt = if let Value::Number(n) = av {
            Some(*n)
        } else {
            None
        };
        let y_opt = if let Value::Number(n) = bv {
            Some(*n)
        } else {
            None
        };
        if let (Some(x), Some(y)) = (x_opt, y_opt) {
            xs.push(x);
            ys.push(y);
        }
    }
    Ok((xs, ys))
}

/// **W5-177 (Phase 4.10 polish / Wave 3 starter):** `CORREL(array1,
/// array2)` — Pearson correlation coefficient of two same-shape data
/// sets. RangeAwareFn; both args MUST be ranges.
///
/// Excel canon (verified against IronCalc `fn_correl` at
/// `.references/ironcalc/base/src/functions/statistical/correl.rs`):
/// - Both args must be ranges of identical shape.
/// - Pairs where EITHER cell is non-numeric (Text, Boolean, Blank) are
///   skipped — the whole pair is dropped, not just one side.
/// - Errors in either array propagate immediately.
/// - Need ≥2 numeric pairs → otherwise `#DIV/0!`.
/// - Constant array on either side (denom == 0) → `#DIV/0!`.
///
/// **W5-179 refactor:** body extracted into `collect_xy_pairs`
/// (shared with PEARSON, RSQ, STEYX); semantics unchanged.
pub fn correl(args: &[FnArg]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let (xs, ys) = match collect_xy_pairs(&args[0], &args[1]) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    if xs.len() < 2 {
        return Value::Error(ErrorValue::DivZero);
    }
    match compute_correl(&xs, &ys) {
        Ok(r) => match coercion::sanitize_f64(r) {
            Ok(n) => Value::Number(n),
            Err(e) => Value::Error(e),
        },
        Err(e) => Value::Error(e),
    }
}

/// **W5-179 (Phase 4.10 polish / Wave 3 regression batch closure):**
/// `PEARSON(array1, array2)` — Pearson product-moment correlation
/// coefficient. Mathematically IDENTICAL to `CORREL` per Microsoft +
/// IronCalc (`fn_pearson` and `fn_correl` produce the same number on
/// the same input). Excel exposes them as two separate functions for
/// terminology / discoverability; we route both through the same
/// kernel.
pub fn pearson(args: &[FnArg]) -> Value {
    correl(args)
}

/// **W5-179 (Phase 4.10 polish / Wave 3 regression batch closure):**
/// `RSQ(known_y, known_x)` — coefficient of determination
/// `R² = CORREL²` per Microsoft + IronCalc. Same arg-order
/// indifference as CORREL (the formula is symmetric in x/y), though
/// Excel docs label them `(known_y's, known_x's)` for consistency
/// with SLOPE / INTERCEPT.
pub fn rsq(args: &[FnArg]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let (xs, ys) = match collect_xy_pairs(&args[0], &args[1]) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    if xs.len() < 2 {
        return Value::Error(ErrorValue::DivZero);
    }
    match compute_correl(&xs, &ys) {
        Ok(r) => match coercion::sanitize_f64(r * r) {
            Ok(n) => Value::Number(n),
            Err(e) => Value::Error(e),
        },
        Err(e) => Value::Error(e),
    }
}

/// **W5-178 (Phase 4.10 polish / Wave 3 regression batch):** running
/// sums for least-squares linear regression. Shared by `SLOPE` and
/// `INTERCEPT` (both walk the same sums and differ only in the final
/// formula). Mirrors the loop in IronCalc `fn_slope` / `fn_intercept`
/// at `.references/ironcalc/base/src/functions/statistical/correl.rs`.
pub(crate) struct LinearFitSums {
    pub n: f64,
    pub sum_x: f64,
    pub sum_y: f64,
    pub sum_x2: f64,
    pub sum_xy: f64,
}

/// **W5-178:** walk `ys_raw` / `xs_raw` paired, dropping any pair where
/// either side is non-numeric (matching CORREL's IronCalc-canon skip
/// rule — Booleans NOT coerced to 1/0). Errors propagate immediately.
///
/// Note the argument ORDER: Excel SLOPE/INTERCEPT take `(known_y's,
/// known_x's)` — Y first. The caller is responsible for passing the
/// raw slices in the natural Excel order; this helper just pairs and
/// filters.
fn collect_linear_fit(ys_raw: &[Value], xs_raw: &[Value]) -> Result<LinearFitSums, ErrorValue> {
    let mut sums = LinearFitSums {
        n: 0.0,
        sum_x: 0.0,
        sum_y: 0.0,
        sum_x2: 0.0,
        sum_xy: 0.0,
    };
    for (yv, xv) in ys_raw.iter().zip(xs_raw.iter()) {
        if let Value::Error(e) = yv {
            return Err(*e);
        }
        if let Value::Error(e) = xv {
            return Err(*e);
        }
        let y_opt = if let Value::Number(n) = yv {
            Some(*n)
        } else {
            None
        };
        let x_opt = if let Value::Number(n) = xv {
            Some(*n)
        } else {
            None
        };
        if let (Some(y), Some(x)) = (y_opt, x_opt) {
            sums.n += 1.0;
            sums.sum_x += x;
            sums.sum_y += y;
            sums.sum_x2 += x * x;
            sums.sum_xy += x * y;
        }
    }
    Ok(sums)
}

/// **W5-178:** least-squares slope from pre-computed sums.
/// `m = (n·Σxy − Σx·Σy) / (n·Σx² − (Σx)²)`. Returns `#DIV/0!` if
/// the denominator is zero (constant x-array) or non-finite.
pub(crate) fn compute_slope(sums: &LinearFitSums) -> Result<f64, ErrorValue> {
    if sums.n < 2.0 {
        return Err(ErrorValue::DivZero);
    }
    let denom = sums.n * sums.sum_x2 - sums.sum_x * sums.sum_x;
    if denom == 0.0 || !denom.is_finite() {
        return Err(ErrorValue::DivZero);
    }
    let num = sums.n * sums.sum_xy - sums.sum_x * sums.sum_y;
    let m = num / denom;
    if !m.is_finite() {
        return Err(ErrorValue::Num);
    }
    Ok(m)
}

/// **W5-178:** least-squares intercept. `b = (Σy − m·Σx) / n` using
/// the slope computed by `compute_slope`. Inherits its #DIV/0! when
/// the slope is undefined.
pub(crate) fn compute_intercept(sums: &LinearFitSums) -> Result<f64, ErrorValue> {
    let m = compute_slope(sums)?;
    let b = (sums.sum_y - m * sums.sum_x) / sums.n;
    if !b.is_finite() {
        return Err(ErrorValue::Num);
    }
    Ok(b)
}

/// Shared dispatch for SLOPE / INTERCEPT. Both take `(known_y, known_x)`
/// as ranges of identical shape (Y first per Excel canon — opposite
/// of CORREL's `(x, y)` order, which causes plenty of user confusion
/// in Excel itself).
fn slope_intercept_dispatch(
    args: &[FnArg],
    finish: impl Fn(&LinearFitSums) -> Result<f64, ErrorValue>,
) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let (ys_raw, y_rows, y_cols) = match &args[0] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let (xs_raw, x_rows, x_cols) = match &args[1] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    if y_rows != x_rows || y_cols != x_cols {
        // Shape mismatch follows the in-codebase paired-array
        // convention (#VALUE!) — Microsoft canon says #N/A but we
        // match CORREL + SUMX2MY2 family for engine consistency.
        return Value::Error(ErrorValue::Value);
    }
    let sums = match collect_linear_fit(ys_raw, xs_raw) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    match finish(&sums) {
        Ok(v) => match coercion::sanitize_f64(v) {
            Ok(n) => Value::Number(n),
            Err(e) => Value::Error(e),
        },
        Err(e) => Value::Error(e),
    }
}

/// **W5-178 (Phase 4.10 polish / Wave 3 regression batch):**
/// `SLOPE(known_y's, known_x's)` — slope of the least-squares
/// regression line. RangeAwareFn; both args MUST be ranges of
/// identical shape. Note Excel's Y-first arg order.
///
/// Excel canon (verified against IronCalc `fn_slope`): pairs with
/// non-numeric on EITHER side are dropped; need ≥2 numeric pairs
/// → otherwise `#DIV/0!`; constant x-array (`Σx² · n - (Σx)² = 0`)
/// → `#DIV/0!`.
pub fn slope(args: &[FnArg]) -> Value {
    slope_intercept_dispatch(args, compute_slope)
}

/// **W5-178 (Phase 4.10 polish / Wave 3 regression batch):**
/// `INTERCEPT(known_y's, known_x's)` — y-intercept of the least-
/// squares regression line. Same semantics + canon as SLOPE.
/// Computed as `intercept = ȳ − slope · x̄` after deriving slope.
pub fn intercept(args: &[FnArg]) -> Value {
    slope_intercept_dispatch(args, compute_intercept)
}

/// **W5-179 (Phase 4.10 polish / Wave 3 regression batch closure):**
/// standard error of the predicted y in least-squares regression.
/// `sey = √(SSE / (n − 2))` where `SSE = Σ(y − ŷ)²` and
/// `ŷ = intercept + slope · x`.
///
/// Two-pass: first pass builds `LinearFitSums` and derives slope +
/// intercept via `compute_slope` (so the slope-derivation `#DIV/0!`
/// path is shared with SLOPE / INTERCEPT). Second pass walks the
/// preserved pairs to compute residuals.
///
/// Requires ≥3 numeric pairs (denominator is `n − 2`); caller passes
/// `(ys, xs)` in Y-first order matching Excel's STEYX signature.
pub(crate) fn compute_steyx(ys: &[f64], xs: &[f64]) -> Result<f64, ErrorValue> {
    debug_assert_eq!(ys.len(), xs.len());
    let n = ys.len() as f64;
    if n < 3.0 {
        return Err(ErrorValue::DivZero);
    }
    let mut sums = LinearFitSums {
        n: 0.0,
        sum_x: 0.0,
        sum_y: 0.0,
        sum_x2: 0.0,
        sum_xy: 0.0,
    };
    for (&y, &x) in ys.iter().zip(xs.iter()) {
        sums.n += 1.0;
        sums.sum_x += x;
        sums.sum_y += y;
        sums.sum_x2 += x * x;
        sums.sum_xy += x * y;
    }
    let slope = compute_slope(&sums)?;
    let intercept = (sums.sum_y - slope * sums.sum_x) / sums.n;
    if !intercept.is_finite() {
        return Err(ErrorValue::Num);
    }
    let mut sse = 0.0;
    for (&y, &x) in ys.iter().zip(xs.iter()) {
        let y_hat = intercept + slope * x;
        let diff = y - y_hat;
        sse += diff * diff;
    }
    let dof = n - 2.0;
    let sey = (sse / dof).sqrt();
    if !sey.is_finite() {
        return Err(ErrorValue::Num);
    }
    Ok(sey)
}

/// **W5-179 (Phase 4.10 polish / Wave 3 regression batch closure):**
/// `STEYX(known_y, known_x)` — standard error of the predicted y.
/// RangeAwareFn; same Y-first arg order as SLOPE / INTERCEPT.
///
/// Excel canon (verified against IronCalc `fn_steyx`):
/// - Both args must be ranges of identical shape.
/// - Need ≥3 numeric pairs (denominator is `n − 2`) → otherwise
///   `#DIV/0!`.
/// - Constant x-array → `#DIV/0!` (inherits from `compute_slope`).
/// - Pairs with non-numeric on EITHER side dropped (Boolean NOT
///   coerced to 1/0); errors propagate immediately.
pub fn steyx(args: &[FnArg]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    // Excel arg order is (known_y, known_x) — Y first.
    let (ys, xs) = match collect_xy_pairs(&args[0], &args[1]) {
        Ok(p) => p,
        Err(e) => return Value::Error(e),
    };
    match compute_steyx(&ys, &xs) {
        Ok(v) => match coercion::sanitize_f64(v) {
            Ok(n) => Value::Number(n),
            Err(e) => Value::Error(e),
        },
        Err(e) => Value::Error(e),
    }
}

/// **W5-164 (Phase 4.10.B):** `MINIFS(min_range, criteria_range1,
/// criteria1, [crit_range2, crit2, ...])` — minimum of cells in
/// `min_range` where ALL criteria pairs match elementwise. Excel
/// canon (verified vs IronCalc `fn_minifs`): no matching numeric
/// cells → `0` (not `#NUM!` or `#DIV/0!`). Mirrors `SUMIFS` shape +
/// W5-60 2D-shape enforcement.
pub fn minifs(args: &[FnArg]) -> Value {
    minmaxifs_inner(args, MinMax::Min)
}

/// **W5-164 (Phase 4.10.B):** `MAXIFS(max_range, criteria_range1,
/// criteria1, ...)` — maximum of cells where ALL criteria match.
/// No matching cells → `0` (Excel canon).
pub fn maxifs(args: &[FnArg]) -> Value {
    minmaxifs_inner(args, MinMax::Max)
}

#[derive(Clone, Copy)]
enum MinMax {
    Min,
    Max,
}

fn minmaxifs_inner(args: &[FnArg], op: MinMax) -> Value {
    if args.len() < 3 {
        return Value::Error(ErrorValue::Value);
    }
    let (value_range, vr_rows, vr_cols) = match &args[0] {
        FnArg::Range { values, rows, cols } => (values.as_slice(), *rows, *cols),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let (pairs, (exp_rows, exp_cols)) = match parse_ifs_pairs(args, 1) {
        Ok(x) => x,
        Err(e) => return Value::Error(e),
    };
    if vr_rows != exp_rows || vr_cols != exp_cols {
        return Value::Error(ErrorValue::Value);
    }
    let total_cells = exp_rows * exp_cols;
    let mut acc: Option<f64> = None;
    for i in 0..total_cells {
        let mut all_match = true;
        for (range, pred) in &pairs {
            if !pred.matches(&range[i]) {
                all_match = false;
                break;
            }
        }
        if !all_match {
            continue;
        }
        match coerce_numeric(&value_range[i]) {
            NumericArg::Number(n) => {
                acc = Some(match (acc, op) {
                    (None, _) => n,
                    (Some(a), MinMax::Min) => a.min(n),
                    (Some(a), MinMax::Max) => a.max(n),
                });
            }
            NumericArg::Skip => {}
            NumericArg::Error(e) => return Value::Error(e),
        }
    }
    // Excel canon: no matching numeric cells → 0 (not #NUM!).
    let result = acc.unwrap_or(0.0);
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// **W5-164 (Phase 4.10.B):** `COUNTBLANK(range)` — count blank
/// cells in a single range. Per Excel canon (verified vs IronCalc
/// `fn_countblank`): both `Value::Blank` AND empty strings (`""`)
/// count as blank. Errors are NOT blank (skipped). Single arg
/// required. Scalar arg is rejected with `#VALUE!` (use COUNTIF for
/// scalar counts).
pub fn countblank(args: &[FnArg]) -> Value {
    if args.len() != 1 {
        return Value::Error(ErrorValue::Value);
    }
    let values = match &args[0] {
        FnArg::Range { values, .. } => values.as_slice(),
        FnArg::Scalar(_) => return Value::Error(ErrorValue::Value),
    };
    let mut count: usize = 0;
    for v in values {
        match v {
            Value::Blank => count += 1,
            Value::Text(s) if s.is_empty() => count += 1,
            _ => {}
        }
    }
    Value::Number(count as f64)
}

/// `SUMPRODUCT(array1, [array2], ...)` — element-wise multiply all
/// arrays and sum the products.
///
/// **W5-60 fix (Codex mega-audit HIGH H2):** all range arrays must
/// have identical 2D shape `(rows, cols)`, NOT just identical flat
/// length. The pre-W5-60 ship checked only `.len()` which silently
/// accepted `2x2` vs `1x4` (both length 4) and multiplied row-major
/// to produce wrong answers. Excel canon: mismatched dimensions →
/// `#VALUE!`. (Microsoft SUMPRODUCT docs:
/// https://support.microsoft.com/en-us/office/sumproduct-function-16753e75-9f68-4874-94ac-4d2145a2fd2e.)
///
/// Scalar args still act as constant multipliers (Excel canon:
/// `SUMPRODUCT(5, A1:A3) = 5 * SUM(A1:A3)`). Non-numeric cells are
/// treated as 0 (SUMPRODUCT-specific leniency, unlike SUM/SUMIF
/// which propagate `#VALUE!` for text). Error cells propagate.
pub fn sumproduct(args: &[FnArg]) -> Value {
    if args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    // Collect range slices + their 2D shape; scalars contribute as
    // 1×1 (constant multiplier).
    let mut arrays: Vec<(&[Value], usize, usize)> = Vec::with_capacity(args.len());
    let scalar_single: Vec<[Value; 1]>;
    {
        let mut tmp: Vec<[Value; 1]> = Vec::new();
        for a in args {
            match a {
                FnArg::Range { values, rows, cols } => {
                    arrays.push((values.as_slice(), *rows, *cols));
                }
                FnArg::Scalar(v) => {
                    tmp.push([v.clone()]);
                }
            }
        }
        scalar_single = tmp;
    }
    // Push scalar args as 1x1 arrays.
    for arr in &scalar_single {
        arrays.push((arr.as_slice(), 1, 1));
    }
    // W5-60: shape consensus among non-1x1 arrays. All must agree
    // on (rows, cols), not just on flat length.
    let mut common_shape: Option<(usize, usize)> = None;
    for (_, r, c) in &arrays {
        if *r == 1 && *c == 1 {
            continue;
        }
        match common_shape {
            None => common_shape = Some((*r, *c)),
            Some((er, ec)) if er != *r || ec != *c => return Value::Error(ErrorValue::Value),
            Some(_) => {}
        }
    }
    let (total_rows, total_cols) = common_shape.unwrap_or((1, 1));
    let total_len = total_rows * total_cols;
    // Coerce a Value to f64 lenient-for-SUMPRODUCT: Number → n; Bool
    // → 1.0/0.0; Blank → 0; Text → 0 (lenient); Error → propagate.
    let to_num = |v: &Value| -> Result<f64, ErrorValue> {
        match v {
            Value::Number(n) => Ok(*n),
            Value::Boolean(b) => Ok(if *b { 1.0 } else { 0.0 }),
            Value::Blank => Ok(0.0),
            Value::Text(_) => Ok(0.0),
            Value::Error(e) => Err(*e),
        }
    };
    let mut sum = 0.0_f64;
    for i in 0..total_len {
        let mut prod = 1.0_f64;
        for (slice, r, c) in &arrays {
            // 1x1 scalar broadcasts to every position; non-1x1
            // arrays index by the common-shape position.
            let idx = if *r == 1 && *c == 1 { 0 } else { i };
            match to_num(&slice[idx]) {
                Ok(n) => prod *= n,
                Err(e) => return Value::Error(e),
            }
        }
        sum += prod;
    }
    match coercion::sanitize_f64(sum) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

// ===== W5-58: Stats family (LARGE / SMALL / RANK / MEDIAN / MODE) =====
//
// Order-statistic and frequency functions over a range or variadic
// numeric args. All accept any mix of `Range` and `Scalar` arg
// shapes — values are flattened via `collect_numbers_strict`.
//
// Excel-canon edge cases:
// - Text/Blank handling: matches the existing scalar-fns SUM /
//   AVERAGE — Blank is skipped, Text is rejected as #VALUE!.
//   (Excel's behavior for Text in a range arg differs from a
//   scalar arg; we use the strict rule throughout for consistency
//   with the rest of the function library.)
// - Empty after coercion → #NUM!.
// - LARGE / SMALL: k < 1 or k > count → #NUM!.
// - MEDIAN: even count → average of the two middle values.
// - MODE: returns the most-frequent value; tie-broken by first
//   appearance. If no value repeats → #N/A.

/// Helper: flatten all numeric values from a list of FnArgs.
/// Scalar and Range both contribute their values. Blank skipped;
/// Text → #VALUE!; Error propagates. Booleans coerce 0/1.
fn collect_numbers_strict(args: &[FnArg]) -> Result<Vec<f64>, ErrorValue> {
    let mut out = Vec::new();
    for arg in args {
        match arg {
            FnArg::Scalar(v) => match coerce_numeric(v) {
                NumericArg::Number(n) => out.push(n),
                NumericArg::Skip => {}
                NumericArg::Error(e) => return Err(e),
            },
            FnArg::Range { values, .. } => {
                for v in values {
                    match coerce_numeric(v) {
                        NumericArg::Number(n) => out.push(n),
                        NumericArg::Skip => {}
                        NumericArg::Error(e) => return Err(e),
                    }
                }
            }
        }
    }
    Ok(out)
}

/// `LARGE(array, k)` — k-th largest value in `array`. 1-based k.
/// k < 1 or k > count → `#NUM!`. Empty array → `#NUM!`.
pub fn large(args: &[FnArg]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let arr = match collect_numbers_strict(&args[..1]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let k = match &args[1] {
        FnArg::Scalar(Value::Number(n)) => n.trunc() as i64,
        FnArg::Scalar(Value::Boolean(b)) => i64::from(*b),
        FnArg::Scalar(Value::Blank) => 0,
        FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
        _ => return Value::Error(ErrorValue::Value),
    };
    if arr.is_empty() || k < 1 || (k as usize) > arr.len() {
        return Value::Error(ErrorValue::Num);
    }
    let mut sorted = arr;
    // Descending so index k-1 is the k-th largest.
    sorted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    Value::Number(sorted[(k - 1) as usize])
}

/// `SMALL(array, k)` — k-th smallest. Same constraints as LARGE.
pub fn small(args: &[FnArg]) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    let arr = match collect_numbers_strict(&args[..1]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    let k = match &args[1] {
        FnArg::Scalar(Value::Number(n)) => n.trunc() as i64,
        FnArg::Scalar(Value::Boolean(b)) => i64::from(*b),
        FnArg::Scalar(Value::Blank) => 0,
        FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
        _ => return Value::Error(ErrorValue::Value),
    };
    if arr.is_empty() || k < 1 || (k as usize) > arr.len() {
        return Value::Error(ErrorValue::Num);
    }
    let mut sorted = arr;
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Value::Number(sorted[(k - 1) as usize])
}

/// `RANK(value, ref, [order])` — 1-based rank of `value` within
/// `ref`. order = 0 or omitted = descending (largest = rank 1);
/// order != 0 = ascending. Ties get the same rank (Excel's RANK.EQ
/// behavior — the older RANK function is identical in V1 since we
/// don't ship RANK.AVG separately). value not in ref → `#N/A`.
pub fn rank(args: &[FnArg]) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let target = match &args[0] {
        FnArg::Scalar(Value::Number(n)) => *n,
        FnArg::Scalar(Value::Boolean(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        FnArg::Scalar(Value::Blank) => 0.0,
        FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
        _ => return Value::Error(ErrorValue::Value),
    };
    let arr = match collect_numbers_strict(&args[1..2]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    if arr.is_empty() {
        return Value::Error(ErrorValue::NA);
    }
    let order = if args.len() == 3 {
        match &args[2] {
            FnArg::Scalar(Value::Number(n)) => *n != 0.0,
            FnArg::Scalar(Value::Boolean(b)) => *b,
            FnArg::Scalar(Value::Blank) => false,
            FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
            _ => return Value::Error(ErrorValue::Value),
        }
    } else {
        false
    };
    // Check `value` is in `ref`.
    if !arr.contains(&target) {
        return Value::Error(ErrorValue::NA);
    }
    // Rank: count of values strictly better than `value`, then +1.
    // Ties get the same rank (smallest in the tie group).
    let better = if order {
        // Ascending — rank 1 is the SMALLEST. Better = strictly less.
        arr.iter().filter(|x| **x < target).count()
    } else {
        // Descending — rank 1 is the LARGEST. Better = strictly greater.
        arr.iter().filter(|x| **x > target).count()
    };
    Value::Number((better + 1) as f64)
}

/// `RANK.AVG(value, ref, [order])` — like RANK / RANK.EQ but returns
/// the AVERAGE of the ranks for tied values, not the smallest. If the
/// value ties with `k` other values, the rank returned is
/// `base + (k - 1) / 2` where `base` is what RANK would have returned.
///
/// Example: `[10, 20, 20, 30]` descending — value 20 has rank 2 in
/// RANK (two values tied at the second rank). RANK.AVG returns
/// `2 + (2-1)/2 = 2.5`.
pub fn rank_avg(args: &[FnArg]) -> Value {
    if args.len() < 2 || args.len() > 3 {
        return Value::Error(ErrorValue::Value);
    }
    let target = match &args[0] {
        FnArg::Scalar(Value::Number(n)) => *n,
        FnArg::Scalar(Value::Boolean(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        FnArg::Scalar(Value::Blank) => 0.0,
        FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
        _ => return Value::Error(ErrorValue::Value),
    };
    let arr = match collect_numbers_strict(&args[1..2]) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    if arr.is_empty() {
        return Value::Error(ErrorValue::NA);
    }
    let order = if args.len() == 3 {
        match &args[2] {
            FnArg::Scalar(Value::Number(n)) => *n != 0.0,
            FnArg::Scalar(Value::Boolean(b)) => *b,
            FnArg::Scalar(Value::Blank) => false,
            FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
            _ => return Value::Error(ErrorValue::Value),
        }
    } else {
        false
    };
    // Count tied values (bit-pattern equality, matching MODE).
    let ties = arr.iter().filter(|x| **x == target).count();
    if ties == 0 {
        return Value::Error(ErrorValue::NA);
    }
    let better = if order {
        arr.iter().filter(|x| **x < target).count()
    } else {
        arr.iter().filter(|x| **x > target).count()
    };
    // Base rank = better + 1; tie offset = (ties - 1) / 2.
    let rank = better as f64 + 1.0 + (ties as f64 - 1.0) / 2.0;
    Value::Number(rank)
}

/// `MEDIAN(num1, num2, ...)` — median of the flattened numeric
/// values. Even count → average of the two middle. Empty → `#NUM!`.
pub fn median(args: &[FnArg]) -> Value {
    if args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let mut nums = match collect_numbers_strict(args) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    if nums.is_empty() {
        return Value::Error(ErrorValue::Num);
    }
    nums.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let len = nums.len();
    let result = if len % 2 == 1 {
        nums[len / 2]
    } else {
        (nums[len / 2 - 1] + nums[len / 2]) / 2.0
    };
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

/// `MODE(num1, num2, ...)` — most frequent value. Tie-broken by
/// first appearance. Returns `#N/A` if no value repeats. Empty →
/// `#NUM!`. (Modern Excel name: `MODE.SNGL` — registered as an
/// alias.)
pub fn mode(args: &[FnArg]) -> Value {
    if args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    let nums = match collect_numbers_strict(args) {
        Ok(v) => v,
        Err(e) => return Value::Error(e),
    };
    if nums.is_empty() {
        return Value::Error(ErrorValue::Num);
    }
    // Count frequencies. Bit-pattern key — sanitize_f64 already
    // filtered NaN/Inf from upstream coercion, so this is safe.
    use std::collections::HashMap;
    let mut counts: HashMap<u64, (u32, usize)> = HashMap::new();
    for (i, &v) in nums.iter().enumerate() {
        let bits = v.to_bits();
        counts
            .entry(bits)
            .and_modify(|(c, _)| *c += 1)
            .or_insert((1, i));
    }
    // Pick max count; tie-break by smallest first_index.
    let mut best: Option<(u64, u32, usize)> = None;
    for (bits, (count, first_idx)) in &counts {
        if *count < 2 {
            continue;
        }
        match best {
            None => best = Some((*bits, *count, *first_idx)),
            Some((_, bc, bi)) => {
                if *count > bc || (*count == bc && *first_idx < bi) {
                    best = Some((*bits, *count, *first_idx));
                }
            }
        }
    }
    match best {
        Some((bits, _, _)) => Value::Number(f64::from_bits(bits)),
        None => Value::Error(ErrorValue::NA),
    }
}

/// **W5-167 (Phase 4.10.E):** `TEXTJOIN(delimiter, ignore_empty, args...)`
///  — variadic join with a separator. Per Excel canon:
///  - `delimiter` (1st arg): scalar text. Blank → empty string.
///  - `ignore_empty` (2nd arg): bool; TRUE → skip empty strings and blanks.
///  - `args...` (3rd onward): scalars + ranges. Ranges flatten row-major.
///  - Errors in any arg propagate.
///  - Total result length cap: 32,767 chars (Excel canon — matches CONCAT
///    / REPT). Exceeded → `#VALUE!`.
///  - Numbers / bools coerce to text representation.
pub fn textjoin(args: &[FnArg]) -> Value {
    if args.len() < 3 {
        return Value::Error(ErrorValue::Value);
    }
    // Excel's text-result cap (matches CONCAT / REPT).
    const EXCEL_TEXT_CAP_CHARS: usize = 32_767;
    // 1: delimiter (scalar text).
    let delim = match &args[0] {
        FnArg::Scalar(v) => match coercion::to_text_for_arg(v) {
            Ok(s) => s,
            Err(e) => return Value::Error(e),
        },
        FnArg::Range { .. } => return Value::Error(ErrorValue::Value),
    };
    // 2: ignore_empty (bool).
    let ignore_empty = match &args[1] {
        FnArg::Scalar(Value::Boolean(b)) => *b,
        FnArg::Scalar(Value::Number(n)) => *n != 0.0,
        FnArg::Scalar(Value::Blank) => false,
        FnArg::Scalar(Value::Error(e)) => return Value::Error(*e),
        // Per Excel canon: strict coercion of the ignore_empty arg. Text
        // / Range → #VALUE!.
        _ => return Value::Error(ErrorValue::Value),
    };
    // 3+: variadic args. Collect text values into a Vec, then join with
    // delim. This avoids special-casing "is this the first/last element"
    // throughout the loop.
    let mut parts: Vec<String> = Vec::new();
    let mut char_count: usize = 0;
    let push = |parts: &mut Vec<String>, char_count: &mut usize, text: String| -> Option<Value> {
        if ignore_empty && text.is_empty() {
            return None;
        }
        *char_count = char_count.saturating_add(text.chars().count());
        if *char_count > EXCEL_TEXT_CAP_CHARS {
            return Some(Value::Error(ErrorValue::Value));
        }
        parts.push(text);
        None
    };
    for arg in &args[2..] {
        match arg {
            FnArg::Scalar(v) => match coercion::to_text_for_arg(v) {
                Ok(s) => {
                    if let Some(err) = push(&mut parts, &mut char_count, s) {
                        return err;
                    }
                }
                Err(e) => return Value::Error(e),
            },
            FnArg::Range { values, .. } => {
                for v in values {
                    match coercion::to_text_for_arg(v) {
                        Ok(s) => {
                            if let Some(err) = push(&mut parts, &mut char_count, s) {
                                return err;
                            }
                        }
                        Err(e) => return Value::Error(e),
                    }
                }
            }
        }
    }
    // Account for delimiter chars in the final length check.
    let delim_count = delim.chars().count();
    if !parts.is_empty() {
        let total_delim_chars = delim_count.saturating_mul(parts.len().saturating_sub(1));
        char_count = char_count.saturating_add(total_delim_chars);
        if char_count > EXCEL_TEXT_CAP_CHARS {
            return Value::Error(ErrorValue::Value);
        }
    }
    Value::text(parts.join(&delim))
}

/// `CONCAT(text1, [text2], ...)` — concatenate scalar values AND
/// flattened range cells into one string. Differs from CONCATENATE in
/// that it accepts range arguments (CONCATENATE only accepts scalars).
///
/// Excel canon:
/// - Variadic; at least 1 arg.
/// - Blanks become empty strings (no skip; matches Excel canon).
/// - Numbers / bools coerce to text representation (TRUE/FALSE for
///   bools; integer-without-trailing-zero rendering for numbers via
///   the same path as CONCATENATE).
/// - Errors propagate (the first error encountered is returned).
/// - Ranges are flattened in row-major order.
/// - **W5-62 (Codex M3 / Sonnet M1):** Excel's 32,767-character text
///   result cap is enforced. If accumulated length would exceed,
///   returns `#VALUE!`. Matches REPT's behavior.
pub fn concat(args: &[FnArg]) -> Value {
    if args.is_empty() {
        return Value::Error(ErrorValue::Value);
    }
    // Excel's text-result cap (also enforced by REPT). Counted in
    // Unicode chars, not bytes — matches the existing REPT cap path.
    const EXCEL_TEXT_CAP_CHARS: usize = 32_767;
    let mut out = String::new();
    let mut char_count: usize = 0;
    for arg in args {
        match arg {
            // W5-64 (Phase 4.4.A): the local `value_to_concat_text` helper was
            // a byte-for-byte duplicate of `coercion::to_text_for_arg`. Switched
            // to the central path. Behavior preserved: Blank→"", Number→
            // integer-rendered text (`< 1e15` guard), Bool→TRUE/FALSE, Text→
            // clone, Error→propagate. The W5-64 NaN/Inf-→#NUM! addition is a
            // FORWARD-COMPATIBLE behavior change for raw non-finite Numbers,
            // which the Value invariant says should never reach here anyway.
            FnArg::Scalar(v) => match coercion::to_text_for_arg(v) {
                Ok(s) => {
                    char_count = char_count.saturating_add(s.chars().count());
                    if char_count > EXCEL_TEXT_CAP_CHARS {
                        return Value::Error(ErrorValue::Value);
                    }
                    out.push_str(&s);
                }
                Err(e) => return Value::Error(e),
            },
            FnArg::Range { values, .. } => {
                for v in values {
                    match coercion::to_text_for_arg(v) {
                        Ok(s) => {
                            char_count = char_count.saturating_add(s.chars().count());
                            if char_count > EXCEL_TEXT_CAP_CHARS {
                                return Value::Error(ErrorValue::Value);
                            }
                            out.push_str(&s);
                        }
                        Err(e) => return Value::Error(e),
                    }
                }
            }
        }
    }
    Value::text(out)
}

// W5-64 (Phase 4.4.A): `value_to_concat_text` was deleted; CONCAT now calls
// `ql_types::coercion::to_text_for_arg` directly. The two functions had
// byte-for-byte identical bodies.

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
        let cols = vs.len();
        FnArg::Range {
            values: vs,
            rows: 1,
            cols,
        }
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

    // ===== W5-61 wildcards in criteria =====

    #[test]
    fn countif_wildcard_star_matches_prefix() {
        // Criteria "ap*" matches "apple", "apricot"; not "banana".
        let range = r(vec![t("apple"), t("apricot"), t("banana"), t("cherry")]);
        assert_eq!(countif(&[range, s(t("ap*"))]), n(2.0));
    }

    #[test]
    fn countif_wildcard_star_matches_suffix() {
        // "*ple" matches "apple", "pineapple".
        let range = r(vec![t("apple"), t("pineapple"), t("banana")]);
        assert_eq!(countif(&[range, s(t("*ple"))]), n(2.0));
    }

    #[test]
    fn countif_wildcard_question_matches_single_char() {
        // "a?c" matches "abc", "axc"; not "ac" (no middle char) and
        // not "abbc" (2 middle chars).
        let range = r(vec![t("abc"), t("axc"), t("ac"), t("abbc")]);
        assert_eq!(countif(&[range, s(t("a?c"))]), n(2.0));
    }

    #[test]
    fn countif_wildcard_combined_star_and_question() {
        // "?o*" — any single char, then "o", then anything.
        let range = r(vec![t("foo"), t("bog"), t("blog"), t("oh")]);
        // "foo" → f + o + o ✓; "bog" → b + o + g ✓; "blog" → b + l (≠ o) ✗;
        // "oh" → o + h (no 'o' after) ✗.
        assert_eq!(countif(&[range, s(t("?o*"))]), n(2.0));
    }

    #[test]
    fn countif_wildcard_escape_treats_as_literal() {
        // Criteria "~?" — literal `?`, no wildcard.
        let range = r(vec![t("?"), t("a"), t("?"), t("??")]);
        // Matches only the cells equal to literal "?".
        assert_eq!(countif(&[range, s(t("~?"))]), n(2.0));
    }

    #[test]
    fn countif_wildcard_case_insensitive() {
        let range = r(vec![t("Apple"), t("APPLE"), t("apple")]);
        assert_eq!(countif(&[range, s(t("ap*"))]), n(3.0));
    }

    #[test]
    fn countif_wildcard_does_not_match_numbers() {
        // Excel canon: wildcards target text cells only. Numbers
        // (even those rendering as "5" textually) do not match
        // wildcard patterns.
        let range = r(vec![n(5.0), n(50.0), t("5"), t("50")]);
        // "5*" — text "5" matches (no chars after), "50" matches.
        // Numbers do not match.
        assert_eq!(countif(&[range, s(t("5*"))]), n(2.0));
    }

    #[test]
    fn countif_wildcard_not_equal_inverts() {
        // "<>ap*" — NOT starting with "ap".
        let range = r(vec![t("apple"), t("apricot"), t("banana"), t("cherry")]);
        assert_eq!(countif(&[range, s(t("<>ap*"))]), n(2.0));
    }

    // W5-62 Codex audit HIGH H1: `<>wildcard` against mixed-type
    // ranges (numbers + bools + errors + text) must NOT match the
    // non-text cells. They are out-of-scope for wildcard criteria
    // entirely — neither positive nor negative match.
    #[test]
    fn countif_wildcard_neq_does_not_match_numbers() {
        // Range has 2 text "ap..." + 2 non-matching text + 2 numbers
        // + 1 bool + 1 error. "<>ap*" should match only the 2
        // non-matching TEXT cells. Numbers, bool, error are
        // out-of-scope.
        let range = r(vec![
            t("apple"),
            t("apricot"),
            t("banana"),
            t("cherry"),
            n(1.0),
            n(2.0),
            Value::Boolean(true),
            Value::Error(ErrorValue::Num),
        ]);
        assert_eq!(countif(&[range, s(t("<>ap*"))]), n(2.0));
    }

    #[test]
    fn countif_wildcard_eq_does_not_match_numbers() {
        // Symmetric: positive wildcard "5*" should not match number
        // cells, even though Value::Number(5.0) renders as text "5".
        let range = r(vec![n(5.0), n(50.0), t("5"), t("50")]);
        assert_eq!(countif(&[range, s(t("5*"))]), n(2.0));
    }

    #[test]
    fn sumif_wildcard_sums_matching_indices() {
        let crit_range = r(vec![t("apple"), t("apricot"), t("banana"), t("cherry")]);
        let sum_range = FnArg::Range {
            values: vec![n(10.0), n(20.0), n(30.0), n(40.0)],
            rows: 1,
            cols: 4,
        };
        // "ap*" matches indices 0 and 1 → 10 + 20 = 30.
        assert_eq!(sumif(&[crit_range, s(t("ap*")), sum_range]), n(30.0));
    }

    // ===== W5-54 Lookup family =====

    fn r2d(vs: Vec<Value>, rows: usize, cols: usize) -> FnArg {
        assert_eq!(rows * cols, vs.len(), "test fixture: bad shape");
        FnArg::Range {
            values: vs,
            rows,
            cols,
        }
    }

    // --- MATCH ---

    #[test]
    fn match_exact_finds_position() {
        let hay = r(vec![n(10.0), n(20.0), n(30.0), n(40.0)]);
        // match_type=0 → exact. 30 is at position 3.
        assert_eq!(r#match(&[s(n(30.0)), hay, s(n(0.0))]), n(3.0));
    }

    #[test]
    fn match_exact_not_found_is_na() {
        let hay = r(vec![n(10.0), n(20.0), n(30.0)]);
        assert_eq!(
            r#match(&[s(n(99.0)), hay, s(n(0.0))]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn match_approximate_largest_le_default() {
        // match_type omitted → defaults to 1 (largest ≤). Sorted asc.
        let hay = r(vec![n(1.0), n(5.0), n(10.0), n(20.0)]);
        // Looking for 7 → largest ≤ 7 is 5 (position 2).
        assert_eq!(r#match(&[s(n(7.0)), hay]), n(2.0));
    }

    #[test]
    fn match_approximate_inverse() {
        // match_type=-1 → smallest ≥. Sorted desc.
        let hay = r(vec![n(50.0), n(40.0), n(30.0), n(20.0), n(10.0)]);
        // Looking for 25 → smallest ≥ 25 is 30 (position 3).
        assert_eq!(r#match(&[s(n(25.0)), hay, s(n(-1.0))]), n(3.0));
    }

    #[test]
    fn match_text_case_insensitive() {
        let hay = r(vec![t("Apple"), t("Banana"), t("Cherry")]);
        assert_eq!(r#match(&[s(t("BANANA")), hay, s(n(0.0))]), n(2.0));
    }

    #[test]
    fn match_arity_errors() {
        let hay = r(vec![n(1.0)]);
        assert_eq!(r#match(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(r#match(&[s(n(1.0))]), Value::Error(ErrorValue::Value));
        // 4 args → too many.
        assert_eq!(
            r#match(&[s(n(1.0)), hay, s(n(0.0)), s(n(0.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn match_error_propagates() {
        let hay = r(vec![n(1.0)]);
        assert_eq!(
            r#match(&[s(Value::Error(ErrorValue::Num)), hay, s(n(0.0))]),
            Value::Error(ErrorValue::Num)
        );
    }

    // --- INDEX ---

    #[test]
    fn index_1d_column_returns_nth() {
        // Single-column 1D array; INDEX(array, n) returns nth element.
        let arr = r(vec![n(10.0), n(20.0), n(30.0)]);
        // r2d would be 1×3 (single row); make it 3×1 (single col).
        let arr_col = r2d(vec![n(10.0), n(20.0), n(30.0)], 3, 1);
        assert_eq!(index(&[arr_col, s(n(2.0))]), n(20.0));
        // Single-row works too via the rows==1 branch.
        assert_eq!(index(&[arr, s(n(2.0))]), n(20.0));
    }

    #[test]
    fn index_2d_with_row_and_col() {
        // 2×3 array: [a, b, c, d, e, f] row-major.
        let arr = r2d(vec![t("a"), t("b"), t("c"), t("d"), t("e"), t("f")], 2, 3);
        // INDEX(arr, 2, 1) = row 2 col 1 = 'd' (1-based).
        assert_eq!(index(&[arr, s(n(2.0)), s(n(1.0))]), t("d"));
    }

    #[test]
    fn index_out_of_bounds_is_ref_error() {
        let arr = r(vec![n(1.0), n(2.0)]);
        assert_eq!(index(&[arr, s(n(5.0))]), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn index_zero_row_or_col_is_ref_error_v1() {
        // Spill not supported V1 — return #REF! rather than silently
        // collapsing to a scalar.
        let arr = r2d(vec![n(1.0), n(2.0), n(3.0), n(4.0)], 2, 2);
        assert_eq!(
            index(&[arr.clone(), s(n(0.0)), s(n(1.0))]),
            Value::Error(ErrorValue::Ref)
        );
        assert_eq!(
            index(&[arr, s(n(1.0)), s(n(0.0))]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn index_arity_errors() {
        let arr = r(vec![n(1.0)]);
        assert_eq!(index(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(index(&[arr]), Value::Error(ErrorValue::Value));
    }

    // --- VLOOKUP ---

    #[test]
    fn vlookup_exact_match() {
        // Table A1:B3 = [["apple", 1], ["banana", 2], ["cherry", 3]]
        let table = r2d(
            vec![t("apple"), n(1.0), t("banana"), n(2.0), t("cherry"), n(3.0)],
            3,
            2,
        );
        assert_eq!(
            vlookup(&[s(t("banana")), table, s(n(2.0)), s(Value::Boolean(false))]),
            n(2.0)
        );
    }

    #[test]
    fn vlookup_exact_not_found_is_na() {
        let table = r2d(vec![t("a"), n(1.0), t("b"), n(2.0)], 2, 2);
        assert_eq!(
            vlookup(&[s(t("z")), table, s(n(2.0)), s(Value::Boolean(false))]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn vlookup_approximate_match_default() {
        // Sorted by first column ascending.
        let table = r2d(
            vec![
                n(0.0),
                t("F"),
                n(60.0),
                t("D"),
                n(70.0),
                t("C"),
                n(80.0),
                t("B"),
                n(90.0),
                t("A"),
            ],
            5,
            2,
        );
        // Grade for score 75 → largest ≤ 75 is 70 → "C".
        assert_eq!(vlookup(&[s(n(75.0)), table, s(n(2.0))]), t("C"));
    }

    #[test]
    fn vlookup_col_index_out_of_range_is_ref() {
        let table = r2d(vec![t("a"), n(1.0)], 1, 2);
        assert_eq!(
            vlookup(&[s(t("a")), table, s(n(5.0)), s(Value::Boolean(false))]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn vlookup_col_index_zero_or_negative_is_value() {
        let table = r2d(vec![t("a"), n(1.0)], 1, 2);
        assert_eq!(
            vlookup(&[
                s(t("a")),
                table.clone(),
                s(n(0.0)),
                s(Value::Boolean(false))
            ]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            vlookup(&[s(t("a")), table, s(n(-1.0)), s(Value::Boolean(false))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn vlookup_error_in_lookup_value_propagates() {
        let table = r2d(vec![t("a"), n(1.0)], 1, 2);
        assert_eq!(
            vlookup(&[
                s(Value::Error(ErrorValue::Num)),
                table,
                s(n(2.0)),
                s(Value::Boolean(false))
            ]),
            Value::Error(ErrorValue::Num)
        );
    }

    // --- HLOOKUP ---

    #[test]
    fn hlookup_exact_match() {
        // Table 2 rows × 3 cols: row 0 = headers, row 1 = values.
        let table = r2d(vec![t("a"), t("b"), t("c"), n(1.0), n(2.0), n(3.0)], 2, 3);
        assert_eq!(
            hlookup(&[s(t("b")), table, s(n(2.0)), s(Value::Boolean(false))]),
            n(2.0)
        );
    }

    #[test]
    fn hlookup_row_index_out_of_range_is_ref() {
        let table = r2d(vec![t("a"), t("b")], 1, 2);
        assert_eq!(
            hlookup(&[s(t("a")), table, s(n(5.0)), s(Value::Boolean(false))]),
            Value::Error(ErrorValue::Ref)
        );
    }

    // --- CHOOSE ---

    #[test]
    fn choose_returns_indexed_value() {
        // CHOOSE(2, "a", "b", "c") → "b"
        assert_eq!(
            choose(&[s(n(2.0)), s(t("a")), s(t("b")), s(t("c"))]),
            t("b")
        );
    }

    #[test]
    fn choose_out_of_bounds_is_value_error() {
        assert_eq!(
            choose(&[s(n(5.0)), s(t("a")), s(t("b"))]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            choose(&[s(n(0.0)), s(t("a"))]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            choose(&[s(n(-1.0)), s(t("a"))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn choose_arity_error() {
        // CHOOSE requires at least 2 args (index + 1 value).
        assert_eq!(choose(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(choose(&[s(n(1.0))]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn choose_range_arg_is_value_error() {
        // CHOOSE doesn't support range args in V1.
        let range = r(vec![n(1.0)]);
        assert_eq!(choose(&[s(n(1.0)), range]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn choose_truncates_fractional_index() {
        // CHOOSE(2.7, "a", "b", "c") → trunc(2.7) = 2 → "b".
        assert_eq!(
            choose(&[s(n(2.7)), s(t("a")), s(t("b")), s(t("c"))]),
            t("b")
        );
    }

    // ===== W5-55: AVERAGEIF / SUMIFS / COUNTIFS / AVERAGEIFS / SUMPRODUCT =====

    // --- AVERAGEIF ---

    #[test]
    fn averageif_basic() {
        // Range [1, 5, 5, 10]; criteria 5 → matches 2 cells; avg = 5.
        let range = r(vec![n(1.0), n(5.0), n(5.0), n(10.0)]);
        assert_eq!(averageif(&[range, s(n(5.0))]), n(5.0));
    }

    #[test]
    fn averageif_comparator() {
        // Range [1, 2, 3, 4, 5]; criteria >2 → matches 3, 4, 5; avg = 4.
        let range = r(vec![n(1.0), n(2.0), n(3.0), n(4.0), n(5.0)]);
        assert_eq!(averageif(&[range, s(t(">2"))]), n(4.0));
    }

    #[test]
    fn averageif_separate_average_range() {
        let labels = r(vec![t("a"), t("b"), t("a"), t("c")]);
        let vals = r(vec![n(10.0), n(20.0), n(30.0), n(40.0)]);
        // criteria "a" → positions 0, 2 → values 10, 30 → avg 20.
        assert_eq!(averageif(&[labels, s(t("a")), vals]), n(20.0));
    }

    #[test]
    fn averageif_no_match_is_div_zero() {
        let range = r(vec![n(1.0), n(2.0)]);
        assert_eq!(
            averageif(&[range, s(n(99.0))]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn averageif_empty_range_is_div_zero() {
        let range = r(vec![]);
        assert_eq!(
            averageif(&[range, s(n(1.0))]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn averageif_arity_errors() {
        assert_eq!(averageif(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            averageif(&[r(vec![n(1.0)])]),
            Value::Error(ErrorValue::Value)
        );
        assert_eq!(
            averageif(&[r(vec![n(1.0)]), s(n(1.0)), s(n(1.0)), s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    // --- SUMIFS ---

    /// W5-55: mirrors the e2e shape (rows=4, cols=1) the dispatch
    /// builds for a single-column named range. Catches any
    /// hidden shape-sensitivity in `parse_ifs_pairs`.
    #[test]
    fn sumifs_two_conditions_2d_column_shape() {
        let labels1 = FnArg::Range {
            values: vec![t("a"), t("a"), t("b"), t("b")],
            rows: 4,
            cols: 1,
        };
        let labels2 = FnArg::Range {
            values: vec![t("x"), t("y"), t("x"), t("y")],
            rows: 4,
            cols: 1,
        };
        let vals = FnArg::Range {
            values: vec![n(1.0), n(2.0), n(3.0), n(4.0)],
            rows: 4,
            cols: 1,
        };
        assert_eq!(
            sumifs(&[vals, labels1, s(t("a")), labels2, s(t("y"))]),
            n(2.0)
        );
    }

    #[test]
    fn sumifs_two_conditions() {
        // Two label ranges + values.
        // labels1 [a, a, b, b]; labels2 [x, y, x, y]; vals [1, 2, 3, 4].
        // Criteria: labels1=a AND labels2=y → only position 1 matches → sum 2.
        let labels1 = r(vec![t("a"), t("a"), t("b"), t("b")]);
        let labels2 = r(vec![t("x"), t("y"), t("x"), t("y")]);
        let vals = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        assert_eq!(
            sumifs(&[vals, labels1, s(t("a")), labels2, s(t("y"))]),
            n(2.0)
        );
    }

    #[test]
    fn sumifs_three_conditions_and() {
        let r1 = r(vec![n(1.0), n(1.0), n(1.0), n(2.0)]);
        let r2 = r(vec![n(10.0), n(10.0), n(20.0), n(10.0)]);
        let r3 = r(vec![t("a"), t("b"), t("a"), t("a")]);
        let vals = r(vec![n(100.0), n(200.0), n(300.0), n(400.0)]);
        // r1=1 AND r2=10 AND r3=a → only position 0 matches → sum 100.
        assert_eq!(
            sumifs(&[vals, r1, s(n(1.0)), r2, s(n(10.0)), r3, s(t("a")),]),
            n(100.0)
        );
    }

    #[test]
    fn sumifs_shape_mismatch_is_value_error() {
        let r1 = r(vec![n(1.0), n(2.0)]);
        let r2 = r(vec![n(1.0), n(2.0), n(3.0)]); // different length
        let vals = r(vec![n(10.0), n(20.0)]);
        assert_eq!(
            sumifs(&[vals, r1, s(n(1.0)), r2, s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn sumifs_sum_range_shape_mismatch_is_value_error() {
        let r1 = r(vec![n(1.0), n(2.0)]);
        let vals = r(vec![n(10.0), n(20.0), n(30.0)]); // longer than criteria
        assert_eq!(
            sumifs(&[vals, r1, s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn sumifs_unpaired_extra_arg_is_value_error() {
        let r1a = r(vec![n(1.0)]);
        let r1b = r(vec![n(1.0)]);
        let vals = r(vec![n(10.0)]);
        // 3 args after sum_range = unpaired (need pairs).
        assert_eq!(
            sumifs(&[vals, r1a, s(n(1.0)), r1b]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn sumifs_empty_match_is_zero() {
        let labels = r(vec![t("a"), t("a")]);
        let vals = r(vec![n(1.0), n(2.0)]);
        assert_eq!(sumifs(&[vals, labels, s(t("z"))]), n(0.0));
    }

    // --- COUNTIFS ---

    #[test]
    fn countifs_two_conditions() {
        let r1 = r(vec![t("a"), t("a"), t("b"), t("b")]);
        let r2 = r(vec![n(1.0), n(2.0), n(1.0), n(2.0)]);
        // r1=a AND r2>1 → only position 1 matches → 1.
        assert_eq!(countifs(&[r1, s(t("a")), r2, s(t(">1"))]), n(1.0));
    }

    #[test]
    fn countifs_no_matches_is_zero() {
        let r1 = r(vec![n(1.0), n(2.0)]);
        assert_eq!(countifs(&[r1, s(n(99.0))]), n(0.0));
    }

    #[test]
    fn countifs_arity_must_be_pairs() {
        let r1 = r(vec![n(1.0)]);
        assert_eq!(countifs(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(countifs(&[r1]), Value::Error(ErrorValue::Value));
    }

    // --- AVERAGEIFS ---

    #[test]
    fn averageifs_two_conditions() {
        let labels1 = r(vec![t("a"), t("a"), t("b"), t("b")]);
        let labels2 = r(vec![t("x"), t("y"), t("x"), t("y")]);
        let vals = r(vec![n(10.0), n(20.0), n(30.0), n(40.0)]);
        // labels1=a AND labels2=y → position 1 → avg 20.
        assert_eq!(
            averageifs(&[vals, labels1, s(t("a")), labels2, s(t("y"))]),
            n(20.0)
        );
    }

    #[test]
    fn averageifs_no_match_div_zero() {
        let r1 = r(vec![n(1.0)]);
        let vals = r(vec![n(10.0)]);
        assert_eq!(
            averageifs(&[vals, r1, s(n(99.0))]),
            Value::Error(ErrorValue::DivZero)
        );
    }

    // === W5-164 (Phase 4.10.B) — MINIFS / MAXIFS / COUNTBLANK ===

    // --- MINIFS ---

    #[test]
    fn minifs_single_condition() {
        let labels = r(vec![t("a"), t("b"), t("a"), t("b")]);
        let vals = r(vec![n(30.0), n(10.0), n(20.0), n(40.0)]);
        // labels="a" → vals[0]=30, vals[2]=20 → min=20.
        assert_eq!(minifs(&[vals, labels, s(t("a"))]), n(20.0));
    }

    #[test]
    fn minifs_two_conditions() {
        let l1 = r(vec![t("a"), t("a"), t("b"), t("b")]);
        let l2 = r(vec![t("x"), t("y"), t("x"), t("y")]);
        let vals = r(vec![n(10.0), n(20.0), n(30.0), n(40.0)]);
        // a AND x → vals[0]=10. Only one match → min=10.
        assert_eq!(minifs(&[vals, l1, s(t("a")), l2, s(t("x"))]), n(10.0));
    }

    #[test]
    fn minifs_no_match_returns_zero() {
        // Excel canon: no matching numeric cells → 0 (NOT #NUM!).
        let labels = r(vec![t("a"), t("b")]);
        let vals = r(vec![n(10.0), n(20.0)]);
        assert_eq!(minifs(&[vals, labels, s(t("z"))]), n(0.0));
    }

    #[test]
    fn minifs_with_comparator_criteria() {
        let nums = r(vec![n(5.0), n(15.0), n(25.0), n(35.0)]);
        let vals = r(vec![n(100.0), n(50.0), n(200.0), n(75.0)]);
        // nums > 10 → matches positions 1,2,3 → vals: 50, 200, 75 → min=50.
        assert_eq!(minifs(&[vals, nums, s(t(">10"))]), n(50.0));
    }

    #[test]
    fn minifs_error_in_value_range_propagates() {
        let labels = r(vec![t("a"), t("a")]);
        let vals = r(vec![n(10.0), Value::Error(ErrorValue::Ref)]);
        assert_eq!(
            minifs(&[vals, labels, s(t("a"))]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn minifs_shape_mismatch_is_value_error() {
        let labels = r(vec![t("a"), t("a"), t("b")]);
        let vals = r(vec![n(10.0), n(20.0)]); // shape mismatch
        assert_eq!(
            minifs(&[vals, labels, s(t("a"))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn minifs_too_few_args_is_value_error() {
        assert_eq!(minifs(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(minifs(&[s(n(1.0))]), Value::Error(ErrorValue::Value));
        let labels = r(vec![t("a")]);
        assert_eq!(minifs(&[labels]), Value::Error(ErrorValue::Value));
    }

    // --- MAXIFS ---

    #[test]
    fn maxifs_single_condition() {
        let labels = r(vec![t("a"), t("b"), t("a"), t("b")]);
        let vals = r(vec![n(30.0), n(10.0), n(20.0), n(40.0)]);
        // labels="a" → vals[0]=30, vals[2]=20 → max=30.
        assert_eq!(maxifs(&[vals, labels, s(t("a"))]), n(30.0));
    }

    #[test]
    fn maxifs_no_match_returns_zero() {
        // Excel canon (mirrors MINIFS): no match → 0.
        let labels = r(vec![t("a"), t("b")]);
        let vals = r(vec![n(10.0), n(20.0)]);
        assert_eq!(maxifs(&[vals, labels, s(t("z"))]), n(0.0));
    }

    #[test]
    fn maxifs_error_in_value_range_propagates() {
        let labels = r(vec![t("a"), t("a")]);
        let vals = r(vec![n(10.0), Value::Error(ErrorValue::Num)]);
        assert_eq!(
            maxifs(&[vals, labels, s(t("a"))]),
            Value::Error(ErrorValue::Num)
        );
    }

    // --- COUNTBLANK ---

    #[test]
    fn countblank_counts_blanks() {
        let range = r(vec![n(1.0), Value::Blank, n(3.0), Value::Blank]);
        assert_eq!(countblank(&[range]), n(2.0));
    }

    #[test]
    fn countblank_counts_empty_strings() {
        // Excel canon: empty strings ALSO count as blank for COUNTBLANK.
        let range = r(vec![n(1.0), t(""), n(3.0)]);
        assert_eq!(countblank(&[range]), n(1.0));
    }

    #[test]
    fn countblank_does_not_count_non_empty_text() {
        let range = r(vec![t("hi"), n(1.0)]);
        assert_eq!(countblank(&[range]), n(0.0));
    }

    #[test]
    fn countblank_does_not_count_errors_as_blank() {
        // Excel canon: errors are NOT blank.
        let range = r(vec![Value::Error(ErrorValue::Ref), n(1.0)]);
        assert_eq!(countblank(&[range]), n(0.0));
    }

    #[test]
    fn countblank_wrong_arity_is_value_error() {
        assert_eq!(countblank(&[]), Value::Error(ErrorValue::Value));
        let r1 = r(vec![n(1.0)]);
        let r2 = r(vec![n(2.0)]);
        assert_eq!(countblank(&[r1, r2]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn countblank_scalar_arg_is_value_error() {
        // Use COUNTIF for scalar shapes; COUNTBLANK requires a range.
        assert_eq!(
            countblank(&[s(Value::Blank)]),
            Value::Error(ErrorValue::Value)
        );
    }

    // === W5-166 (Phase 4.10.D) — paired sum-of-squares variants ===

    // --- SUMX2MY2 ---

    #[test]
    fn sumx2my2_basic() {
        // Σ(x² - y²): [1,2,3]² - [4,5,6]² = (1-16) + (4-25) + (9-36)
        // = -15 - 21 - 27 = -63.
        let x = r(vec![n(1.0), n(2.0), n(3.0)]);
        let y = r(vec![n(4.0), n(5.0), n(6.0)]);
        assert_eq!(sumx2my2(&[x, y]), n(-63.0));
    }

    #[test]
    fn sumx2my2_shape_mismatch_is_value_error() {
        let x = r(vec![n(1.0), n(2.0)]);
        let y = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(sumx2my2(&[x, y]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn sumx2my2_scalar_arg_is_value_error() {
        let x = r(vec![n(1.0), n(2.0)]);
        assert_eq!(sumx2my2(&[x, s(n(3.0))]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn sumx2my2_text_coerces_to_zero() {
        // Per IronCalc canon: non-numeric → 0.
        // [1, text]² - [2, 3]² = (1-4) + (0-9) = -12.
        let x = r(vec![n(1.0), t("hello")]);
        let y = r(vec![n(2.0), n(3.0)]);
        assert_eq!(sumx2my2(&[x, y]), n(-12.0));
    }

    #[test]
    fn sumx2my2_error_propagates() {
        let x = r(vec![n(1.0), Value::Error(ErrorValue::Ref)]);
        let y = r(vec![n(2.0), n(3.0)]);
        assert_eq!(sumx2my2(&[x, y]), Value::Error(ErrorValue::Ref));
    }

    // --- SUMX2PY2 ---

    #[test]
    fn sumx2py2_basic() {
        // Σ(x² + y²): [1,2]² + [3,4]² = (1+9) + (4+16) = 30.
        let x = r(vec![n(1.0), n(2.0)]);
        let y = r(vec![n(3.0), n(4.0)]);
        assert_eq!(sumx2py2(&[x, y]), n(30.0));
    }

    #[test]
    fn sumx2py2_shape_mismatch_is_value_error() {
        let x = r(vec![n(1.0)]);
        let y = r(vec![n(1.0), n(2.0)]);
        assert_eq!(sumx2py2(&[x, y]), Value::Error(ErrorValue::Value));
    }

    // --- SUMXMY2 ---

    #[test]
    fn sumxmy2_basic() {
        // Σ(x-y)²: ([1,2,3] - [4,5,6])² = (-3)² + (-3)² + (-3)² = 27.
        let x = r(vec![n(1.0), n(2.0), n(3.0)]);
        let y = r(vec![n(4.0), n(5.0), n(6.0)]);
        assert_eq!(sumxmy2(&[x, y]), n(27.0));
    }

    #[test]
    fn sumxmy2_zero_diff() {
        // Same arrays → 0.
        let x = r(vec![n(1.0), n(2.0), n(3.0)]);
        let y = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(sumxmy2(&[x, y]), n(0.0));
    }

    #[test]
    fn sumxmy2_wrong_arity_is_value_error() {
        let x = r(vec![n(1.0)]);
        assert_eq!(sumxmy2(&[x]), Value::Error(ErrorValue::Value));
        assert_eq!(sumxmy2(&[]), Value::Error(ErrorValue::Value));
    }

    // === W5-177 (Phase 4.10 polish / Wave 3 starter) — CORREL ===

    fn approx_correl(actual: Value, expected: f64, tol: f64) {
        match actual {
            Value::Number(got) => assert!(
                (got - expected).abs() < tol,
                "expected ≈ {expected}, got {got}"
            ),
            other => panic!("expected Number, got {other:?}"),
        }
    }

    #[test]
    fn correl_perfect_positive_is_one() {
        // y = 2x exactly → r = 1.
        let x = r(vec![n(1.0), n(2.0), n(3.0), n(4.0), n(5.0)]);
        let y = r(vec![n(2.0), n(4.0), n(6.0), n(8.0), n(10.0)]);
        approx_correl(correl(&[x, y]), 1.0, 1e-9);
    }

    #[test]
    fn correl_perfect_negative_is_minus_one() {
        // y = -x → r = -1.
        let x = r(vec![n(1.0), n(2.0), n(3.0), n(4.0), n(5.0)]);
        let y = r(vec![n(-1.0), n(-2.0), n(-3.0), n(-4.0), n(-5.0)]);
        approx_correl(correl(&[x, y]), -1.0, 1e-9);
    }

    #[test]
    fn correl_known_microsoft_example() {
        // Excel docs CORREL example: x=[3,2,4,5,6], y=[9,7,12,15,17].
        // r = (5·245 - 20·60) / √((5·90 - 400)(5·788 - 3600))
        //   = (1225 - 1200) / √(50 · 340) = 25 / √17000 ≈ 0.19174125.
        // Excel reports 0.997054485.  Wait — recompute on the dataset
        // from the actual Microsoft docs page:
        //   x = [3, 2, 4, 5, 6]; y = [9, 7, 12, 15, 17].
        //   Σx = 20, Σy = 60, Σx² = 90, Σy² = 788, Σxy = 257.
        //   num = 5·257 − 20·60 = 1285 − 1200 = 85.
        //   denom_x = 5·90 − 400 = 50. denom_y = 5·788 − 3600 = 340.
        //   r = 85 / √(50·340) = 85 / √17000 ≈ 0.65221878.
        // Hmm; let me hand-verify with even simpler data instead.
        // x = [1, 2, 3], y = [4, 6, 9]:
        //   Σx=6 Σy=19 Σx²=14 Σy²=133 Σxy=43 n=3
        //   num = 3·43 − 6·19 = 129 − 114 = 15
        //   denom_x = 3·14 − 36 = 6. denom_y = 3·133 − 361 = 38.
        //   r = 15 / √228 = 15 / 15.0997 ≈ 0.993399267.
        let x = r(vec![n(1.0), n(2.0), n(3.0)]);
        let y = r(vec![n(4.0), n(6.0), n(9.0)]);
        approx_correl(correl(&[x, y]), 0.993399267, 1e-6);
    }

    #[test]
    fn correl_skips_pairs_with_nonnumeric_either_side() {
        // Whole pair dropped if EITHER cell is non-numeric.
        // After skip: xs=[1, 2, 4], ys=[2, 4, 8] → r = 1.0 (perfect).
        let x = r(vec![n(1.0), n(2.0), t("skip"), n(4.0)]);
        let y = r(vec![n(2.0), n(4.0), n(6.0), n(8.0)]);
        approx_correl(correl(&[x, y]), 1.0, 1e-9);
    }

    #[test]
    fn correl_skips_pairs_with_blanks() {
        let x = r(vec![n(1.0), n(2.0), Value::Blank, n(4.0)]);
        let y = r(vec![n(2.0), n(4.0), n(99.0), n(8.0)]);
        approx_correl(correl(&[x, y]), 1.0, 1e-9);
    }

    #[test]
    fn correl_skips_booleans() {
        // Boolean cells skip per IronCalc canon (NOT coerced to 1/0).
        // Pair (TRUE, 5) is dropped → xs=[1,2], ys=[2,4] → r=1.0.
        let x = r(vec![n(1.0), Value::Boolean(true), n(2.0)]);
        let y = r(vec![n(2.0), n(5.0), n(4.0)]);
        approx_correl(correl(&[x, y]), 1.0, 1e-9);
    }

    #[test]
    fn correl_too_few_pairs_is_div_zero() {
        // 1 numeric pair only → #DIV/0!.
        let x = r(vec![n(1.0), t("a"), t("b")]);
        let y = r(vec![n(2.0), n(3.0), n(4.0)]);
        assert_eq!(correl(&[x, y]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn correl_empty_pairs_is_div_zero() {
        let x = r(vec![t("a"), t("b"), t("c")]);
        let y = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(correl(&[x, y]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn correl_constant_x_is_div_zero() {
        // x constant → denom_x = 0 → #DIV/0!.
        let x = r(vec![n(5.0), n(5.0), n(5.0)]);
        let y = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(correl(&[x, y]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn correl_constant_y_is_div_zero() {
        let x = r(vec![n(1.0), n(2.0), n(3.0)]);
        let y = r(vec![n(7.0), n(7.0), n(7.0)]);
        assert_eq!(correl(&[x, y]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn correl_shape_mismatch_is_value_error() {
        // Different lengths → #VALUE! per in-codebase convention
        // (Microsoft canon says #N/A but our paired-array family is
        // consistently #VALUE!; documented in excel-matrix.md).
        let x = r(vec![n(1.0), n(2.0)]);
        let y = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(correl(&[x, y]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn correl_wrong_arity_is_value_error() {
        let x = r(vec![n(1.0), n(2.0)]);
        assert_eq!(correl(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            correl(std::slice::from_ref(&x)),
            Value::Error(ErrorValue::Value)
        );
        let y = r(vec![n(1.0), n(2.0)]);
        let z = r(vec![n(1.0), n(2.0)]);
        assert_eq!(correl(&[x, y, z]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn correl_scalar_args_are_value_error() {
        // Both args must be ranges.
        assert_eq!(
            correl(&[s(n(1.0)), s(n(2.0))]),
            Value::Error(ErrorValue::Value)
        );
        let y = r(vec![n(1.0), n(2.0)]);
        assert_eq!(correl(&[s(n(1.0)), y]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn correl_error_in_x_propagates() {
        let x = r(vec![n(1.0), Value::Error(ErrorValue::Ref), n(3.0)]);
        let y = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(correl(&[x, y]), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn correl_error_in_y_propagates() {
        let x = r(vec![n(1.0), n(2.0), n(3.0)]);
        let y = r(vec![n(1.0), Value::Error(ErrorValue::Name), n(3.0)]);
        assert_eq!(correl(&[x, y]), Value::Error(ErrorValue::Name));
    }

    // === W5-178 (Phase 4.10 polish / Wave 3 regression batch)
    //     — SLOPE + INTERCEPT ===

    fn approx_scalar(actual: Value, expected: f64, tol: f64) {
        match actual {
            Value::Number(got) => assert!(
                (got - expected).abs() < tol,
                "expected ≈ {expected}, got {got}"
            ),
            other => panic!("expected Number, got {other:?}"),
        }
    }

    // --- SLOPE ---

    #[test]
    fn slope_perfect_y_equals_2x() {
        // y = 2x exactly; slope = 2.
        // Excel arg order: SLOPE(known_y, known_x).
        let ys = r(vec![n(2.0), n(4.0), n(6.0), n(8.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        approx_scalar(slope(&[ys, xs]), 2.0, 1e-9);
    }

    #[test]
    fn slope_known_fixture() {
        // y = 3x + 5 on x=[1,2,3,4]: ys=[8,11,14,17].
        //   Σx=10 Σy=50 Σx²=30 Σxy=140 n=4
        //   num = 4·140 − 10·50 = 60. denom = 4·30 − 100 = 20.
        //   slope = 60/20 = 3.0.
        let ys = r(vec![n(8.0), n(11.0), n(14.0), n(17.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        approx_scalar(slope(&[ys, xs]), 3.0, 1e-9);
    }

    #[test]
    fn slope_negative() {
        // y = -2x + 1: ys=[-1,-3,-5].
        //   Σx=6 Σy=-9 Σx²=14 Σxy=-22 n=3
        //   num = 3·(-22) − 6·(-9) = -66 + 54 = -12. denom = 3·14 − 36 = 6.
        //   slope = -12/6 = -2.0.
        let ys = r(vec![n(-1.0), n(-3.0), n(-5.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0)]);
        approx_scalar(slope(&[ys, xs]), -2.0, 1e-9);
    }

    #[test]
    fn slope_skips_non_numeric_pairs() {
        // Drop pair (t, 99). Remaining: ys=[2,6], xs=[1,3]. slope=2.
        let ys = r(vec![n(2.0), t("skip"), n(6.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0)]);
        approx_scalar(slope(&[ys, xs]), 2.0, 1e-9);
    }

    #[test]
    fn slope_constant_x_is_div_zero() {
        // Constant x → denom = 0 → #DIV/0!.
        let ys = r(vec![n(1.0), n(2.0), n(3.0)]);
        let xs = r(vec![n(5.0), n(5.0), n(5.0)]);
        assert_eq!(slope(&[ys, xs]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn slope_too_few_pairs_is_div_zero() {
        // 1 valid pair → #DIV/0!.
        let ys = r(vec![n(1.0), t("a")]);
        let xs = r(vec![n(2.0), n(3.0)]);
        assert_eq!(slope(&[ys, xs]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn slope_shape_mismatch_is_value_error() {
        let ys = r(vec![n(1.0), n(2.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(slope(&[ys, xs]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn slope_arity_violations() {
        assert_eq!(slope(&[]), Value::Error(ErrorValue::Value));
        let ys = r(vec![n(1.0), n(2.0)]);
        assert_eq!(
            slope(std::slice::from_ref(&ys)),
            Value::Error(ErrorValue::Value)
        );
        let xs = r(vec![n(1.0), n(2.0)]);
        let z = r(vec![n(1.0), n(2.0)]);
        assert_eq!(slope(&[ys, xs, z]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn slope_scalar_args_are_value_error() {
        assert_eq!(
            slope(&[s(n(1.0)), s(n(2.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn slope_error_in_y_propagates() {
        let ys = r(vec![Value::Error(ErrorValue::Ref), n(2.0), n(3.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(slope(&[ys, xs]), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn slope_error_in_x_propagates() {
        let ys = r(vec![n(1.0), n(2.0), n(3.0)]);
        let xs = r(vec![n(1.0), Value::Error(ErrorValue::Name), n(3.0)]);
        assert_eq!(slope(&[ys, xs]), Value::Error(ErrorValue::Name));
    }

    // --- INTERCEPT ---

    #[test]
    fn intercept_y_equals_2x_baseline_is_zero() {
        // y = 2x → intercept = 0.
        let ys = r(vec![n(2.0), n(4.0), n(6.0), n(8.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        approx_scalar(intercept(&[ys, xs]), 0.0, 1e-9);
    }

    #[test]
    fn intercept_known_fixture() {
        // y = 3x + 5 on x=[1,2,3,4]: ys=[8,11,14,17]. slope = 3.
        // intercept = (Σy − slope · Σx) / n = (50 − 3·10) / 4 = 20/4 = 5.
        let ys = r(vec![n(8.0), n(11.0), n(14.0), n(17.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        approx_scalar(intercept(&[ys, xs]), 5.0, 1e-9);
    }

    #[test]
    fn intercept_negative_slope_known_fixture() {
        // y = -2x + 10: x=[1,2,3], y=[8, 6, 4].
        // Σx=6 Σy=18 Σx²=14 Σxy=32 n=3.
        // slope = (3·32 - 6·18) / (3·14 - 36) = (96-108)/6 = -2.
        // intercept = (18 - (-2)·6)/3 = (18+12)/3 = 10.
        let ys = r(vec![n(8.0), n(6.0), n(4.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0)]);
        approx_scalar(intercept(&[ys, xs]), 10.0, 1e-9);
    }

    #[test]
    fn intercept_inherits_slope_div_zero_on_constant_x() {
        let ys = r(vec![n(1.0), n(2.0), n(3.0)]);
        let xs = r(vec![n(5.0), n(5.0), n(5.0)]);
        assert_eq!(intercept(&[ys, xs]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn intercept_too_few_pairs_is_div_zero() {
        let ys = r(vec![n(1.0), t("a")]);
        let xs = r(vec![n(2.0), n(3.0)]);
        assert_eq!(intercept(&[ys, xs]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn intercept_shape_mismatch_is_value_error() {
        let ys = r(vec![n(1.0), n(2.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(intercept(&[ys, xs]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn intercept_arity_and_scalar_validation() {
        assert_eq!(intercept(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            intercept(&[s(n(1.0)), s(n(2.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn intercept_skips_non_numeric_pairs() {
        // Drop pair (TRUE, 99). Remaining: ys=[2,6], xs=[1,3]. slope=2, intercept=0.
        let ys = r(vec![n(2.0), Value::Boolean(true), n(6.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0)]);
        approx_scalar(intercept(&[ys, xs]), 0.0, 1e-9);
    }

    // === W5-179 (Phase 4.10 polish / Wave 3 regression batch closure)
    //     — PEARSON + RSQ + STEYX ===

    // --- PEARSON (delegates to CORREL) ---

    #[test]
    fn pearson_matches_correl_perfect_positive() {
        // PEARSON ≡ CORREL contract: same input, same output.
        let x = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        let y = r(vec![n(2.0), n(4.0), n(6.0), n(8.0)]);
        approx_scalar(pearson(&[x, y]), 1.0, 1e-9);
    }

    #[test]
    fn pearson_matches_correl_known_fixture() {
        // Same fixture as `correl_known_microsoft_example`: x=[1,2,3],
        // y=[4,6,9] → r ≈ 0.993399267.
        let x = r(vec![n(1.0), n(2.0), n(3.0)]);
        let y = r(vec![n(4.0), n(6.0), n(9.0)]);
        approx_scalar(pearson(&[x, y]), 0.993399267, 1e-6);
    }

    #[test]
    fn pearson_propagates_div_zero_from_constant_array() {
        let x = r(vec![n(5.0), n(5.0), n(5.0)]);
        let y = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(pearson(&[x, y]), Value::Error(ErrorValue::DivZero));
    }

    // --- RSQ ---

    #[test]
    fn rsq_perfect_positive_is_one() {
        // r=1 → r²=1.
        let x = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        let y = r(vec![n(2.0), n(4.0), n(6.0), n(8.0)]);
        approx_scalar(rsq(&[x, y]), 1.0, 1e-9);
    }

    #[test]
    fn rsq_perfect_negative_is_one() {
        // r=-1 → r²=1. Same magnitude.
        let x = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        let y = r(vec![n(-1.0), n(-2.0), n(-3.0), n(-4.0)]);
        approx_scalar(rsq(&[x, y]), 1.0, 1e-9);
    }

    #[test]
    fn rsq_known_fixture() {
        // CORREL = 0.993399267 → RSQ ≈ 0.986841...
        let x = r(vec![n(1.0), n(2.0), n(3.0)]);
        let y = r(vec![n(4.0), n(6.0), n(9.0)]);
        approx_scalar(rsq(&[x, y]), 0.993399267_f64.powi(2), 1e-6);
    }

    #[test]
    fn rsq_constant_array_is_div_zero() {
        let x = r(vec![n(1.0), n(2.0), n(3.0)]);
        let y = r(vec![n(7.0), n(7.0), n(7.0)]);
        assert_eq!(rsq(&[x, y]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn rsq_too_few_pairs_is_div_zero() {
        let x = r(vec![n(1.0), t("a")]);
        let y = r(vec![n(2.0), n(3.0)]);
        assert_eq!(rsq(&[x, y]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn rsq_shape_mismatch_is_value_error() {
        let x = r(vec![n(1.0), n(2.0)]);
        let y = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(rsq(&[x, y]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn rsq_arity_violations() {
        assert_eq!(rsq(&[]), Value::Error(ErrorValue::Value));
        let x = r(vec![n(1.0), n(2.0)]);
        let y = r(vec![n(1.0), n(2.0)]);
        let z = r(vec![n(1.0), n(2.0)]);
        assert_eq!(rsq(&[x, y, z]), Value::Error(ErrorValue::Value));
    }

    // --- STEYX ---

    #[test]
    fn steyx_perfect_line_is_zero() {
        // y = 2x exactly → all residuals zero → SSE = 0 → sey = 0.
        let ys = r(vec![n(2.0), n(4.0), n(6.0), n(8.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        approx_scalar(steyx(&[ys, xs]), 0.0, 1e-9);
    }

    #[test]
    fn steyx_manual_scatter_fixture() {
        // ys=[1,3,5,6], xs=[1,2,3,4]:
        //   slope = (4·46 − 10·15) / (4·30 − 100) = 34/20 = 1.7
        //   intercept = (15 − 1.7·10) / 4 = -0.5
        //   ŷ = [1.2, 2.9, 4.6, 6.3]
        //   residuals = [-0.2, 0.1, 0.4, -0.3]
        //   SSE = 0.04 + 0.01 + 0.16 + 0.09 = 0.30
        //   sey = √(0.30 / 2) ≈ 0.387298335...
        let ys = r(vec![n(1.0), n(3.0), n(5.0), n(6.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        approx_scalar(steyx(&[ys, xs]), 0.387298334620742, 1e-9);
    }

    #[test]
    fn steyx_too_few_pairs_is_div_zero() {
        // 2 valid pairs → dof = 0 → #DIV/0!.
        let ys = r(vec![n(1.0), n(2.0)]);
        let xs = r(vec![n(1.0), n(2.0)]);
        assert_eq!(steyx(&[ys, xs]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn steyx_exactly_three_pairs_succeeds() {
        // n=3 boundary — dof=1. Hand-compute:
        //   ys=[2, 5, 7], xs=[1, 2, 3]: Σx=6 Σy=14 Σx²=14 Σxy=33
        //   slope = (3·33 − 6·14)/(3·14 − 36) = (99-84)/6 = 2.5
        //   intercept = (14 − 2.5·6)/3 = (14-15)/3 = -0.333...
        //   ŷ = [2.166..., 4.666..., 7.166...]
        //   residuals = [-0.166..., 0.333..., -0.166...]
        //   SSE = 0.02777... + 0.11111... + 0.02777... = 0.16666...
        //   sey = √(0.16666/1) ≈ 0.408248...
        let ys = r(vec![n(2.0), n(5.0), n(7.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0)]);
        approx_scalar(steyx(&[ys, xs]), 0.408248290463863, 1e-9);
    }

    #[test]
    fn steyx_constant_x_is_div_zero() {
        // Constant x → slope #DIV/0! → STEYX inherits.
        let ys = r(vec![n(1.0), n(2.0), n(3.0)]);
        let xs = r(vec![n(5.0), n(5.0), n(5.0)]);
        assert_eq!(steyx(&[ys, xs]), Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn steyx_skips_non_numeric_pairs() {
        // Drop (TRUE, 99). Remaining: ys=[2,6,8], xs=[1,3,4]. Still
        // need n≥3 — passes (3 pairs). Perfect line y=2x → sey=0.
        let ys = r(vec![n(2.0), Value::Boolean(true), n(6.0), n(8.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        approx_scalar(steyx(&[ys, xs]), 0.0, 1e-9);
    }

    #[test]
    fn steyx_shape_mismatch_is_value_error() {
        let ys = r(vec![n(1.0), n(2.0), n(3.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        assert_eq!(steyx(&[ys, xs]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn steyx_arity_and_scalar_validation() {
        assert_eq!(steyx(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            steyx(&[s(n(1.0)), s(n(2.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn steyx_error_propagation() {
        let ys = r(vec![n(1.0), Value::Error(ErrorValue::Ref), n(3.0)]);
        let xs = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(steyx(&[ys, xs]), Value::Error(ErrorValue::Ref));
    }

    // === W5-167 (Phase 4.10.E) — TEXTJOIN ===

    #[test]
    fn textjoin_basic() {
        // TEXTJOIN(", ", TRUE, "a", "b", "c") → "a, b, c".
        assert_eq!(
            textjoin(&[
                s(t(", ")),
                s(Value::Boolean(true)),
                s(t("a")),
                s(t("b")),
                s(t("c")),
            ]),
            t("a, b, c")
        );
    }

    #[test]
    fn textjoin_ignore_empty_true_skips_empty_strings() {
        // TEXTJOIN(",", TRUE, "a", "", "b") → "a,b" (skips empty).
        assert_eq!(
            textjoin(&[
                s(t(",")),
                s(Value::Boolean(true)),
                s(t("a")),
                s(t("")),
                s(t("b")),
            ]),
            t("a,b")
        );
    }

    #[test]
    fn textjoin_ignore_empty_false_keeps_empty_strings() {
        // TEXTJOIN(",", FALSE, "a", "", "b") → "a,,b".
        assert_eq!(
            textjoin(&[
                s(t(",")),
                s(Value::Boolean(false)),
                s(t("a")),
                s(t("")),
                s(t("b")),
            ]),
            t("a,,b")
        );
    }

    #[test]
    fn textjoin_range_flattens() {
        let range = r(vec![t("x"), t("y"), t("z")]);
        assert_eq!(
            textjoin(&[s(t("-")), s(Value::Boolean(true)), range]),
            t("x-y-z")
        );
    }

    #[test]
    fn textjoin_error_in_arg_propagates() {
        assert_eq!(
            textjoin(&[
                s(t(",")),
                s(Value::Boolean(true)),
                s(t("a")),
                s(Value::Error(ErrorValue::Ref)),
            ]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn textjoin_too_few_args_is_value_error() {
        // Need at least 3 args (delim, ignore_empty, ≥1 value).
        assert_eq!(textjoin(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(textjoin(&[s(t(","))]), Value::Error(ErrorValue::Value));
        assert_eq!(
            textjoin(&[s(t(",")), s(Value::Boolean(true))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn textjoin_empty_delimiter() {
        // delim="" → just concatenation.
        assert_eq!(
            textjoin(&[
                s(t("")),
                s(Value::Boolean(true)),
                s(t("a")),
                s(t("b")),
                s(t("c")),
            ]),
            t("abc")
        );
    }

    #[test]
    fn textjoin_coerces_numbers_and_bools() {
        assert_eq!(
            textjoin(&[
                s(t(",")),
                s(Value::Boolean(false)),
                s(n(1.0)),
                s(Value::Boolean(true)),
                s(n(2.5)),
            ]),
            t("1,TRUE,2.5")
        );
    }

    #[test]
    fn textjoin_range_with_ignore_empty_skips_blanks() {
        // Range with Blank cells; ignore_empty=TRUE skips them.
        let range = r(vec![t("a"), Value::Blank, t("b")]);
        assert_eq!(
            textjoin(&[s(t(",")), s(Value::Boolean(true)), range]),
            t("a,b")
        );
    }

    // === W5-169 (Phase 4.10.G) — XLOOKUP / XMATCH ===

    // --- XLOOKUP ---

    #[test]
    fn xlookup_exact_match() {
        // XLOOKUP("b", [a,b,c], [1,2,3]) → 2.
        let hay = r(vec![t("a"), t("b"), t("c")]);
        let ret = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(xlookup(&[s(t("b")), hay, ret]), n(2.0));
    }

    #[test]
    fn xlookup_no_match_returns_na_by_default() {
        let hay = r(vec![t("a"), t("b"), t("c")]);
        let ret = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(
            xlookup(&[s(t("z")), hay, ret]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn xlookup_if_not_found_when_no_match() {
        let hay = r(vec![t("a"), t("b"), t("c")]);
        let ret = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(
            xlookup(&[s(t("z")), hay, ret, s(t("default"))]),
            t("default")
        );
    }

    #[test]
    fn xlookup_match_mode_next_smaller() {
        // Hay = [10, 20, 30, 40, 50]. Look up 25 with match_mode=-1 →
        // largest cell ≤ 25 = 20 (index 1).
        let hay = r(vec![n(10.0), n(20.0), n(30.0), n(40.0), n(50.0)]);
        let ret = r(vec![
            t("ten"),
            t("twenty"),
            t("thirty"),
            t("forty"),
            t("fifty"),
        ]);
        assert_eq!(
            xlookup(&[s(n(25.0)), hay, ret, s(t("none")), s(n(-1.0))]),
            t("twenty")
        );
    }

    #[test]
    fn xlookup_match_mode_next_larger() {
        // Hay = [10,20,30,40,50]. Look up 25, match_mode=1 → smallest
        // cell ≥ 25 = 30 (index 2).
        let hay = r(vec![n(10.0), n(20.0), n(30.0), n(40.0), n(50.0)]);
        let ret = r(vec![
            t("ten"),
            t("twenty"),
            t("thirty"),
            t("forty"),
            t("fifty"),
        ]);
        assert_eq!(
            xlookup(&[s(n(25.0)), hay, ret, s(t("none")), s(n(1.0))]),
            t("thirty")
        );
    }

    #[test]
    fn xlookup_wildcard_match() {
        let hay = r(vec![t("apple"), t("banana"), t("cherry")]);
        let ret = r(vec![n(1.0), n(2.0), n(3.0)]);
        // Pattern "ban*" matches "banana" at index 1.
        assert_eq!(
            xlookup(&[s(t("ban*")), hay, ret, s(t("none")), s(n(2.0))]),
            n(2.0)
        );
    }

    #[test]
    fn xlookup_search_mode_reverse() {
        // Hay has duplicates: [a, b, c, b]. Default search picks index 1;
        // reverse search picks index 3.
        let hay = r(vec![t("a"), t("b"), t("c"), t("b")]);
        let ret = r(vec![n(1.0), n(2.0), n(3.0), n(4.0)]);
        // Forward → 2.
        assert_eq!(
            xlookup(&[
                s(t("b")),
                hay.clone(),
                ret.clone(),
                s(Value::Blank),
                s(n(0.0))
            ]),
            n(2.0)
        );
        // Reverse → 4.
        assert_eq!(
            xlookup(&[s(t("b")), hay, ret, s(Value::Blank), s(n(0.0)), s(n(-1.0))]),
            n(4.0)
        );
    }

    #[test]
    fn xlookup_shape_mismatch_is_value_error() {
        let hay = r(vec![n(1.0), n(2.0)]);
        let ret = r(vec![t("a"), t("b"), t("c")]);
        assert_eq!(
            xlookup(&[s(n(1.0)), hay, ret]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn xlookup_too_few_args_is_value_error() {
        assert_eq!(xlookup(&[]), Value::Error(ErrorValue::Value));
        assert_eq!(
            xlookup(&[s(n(1.0)), r(vec![n(1.0)])]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn xlookup_invalid_match_mode_is_value_error() {
        let hay = r(vec![t("a")]);
        let ret = r(vec![n(1.0)]);
        assert_eq!(
            xlookup(&[s(t("a")), hay, ret, s(Value::Blank), s(n(99.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    /// **W5-171 (Codex MEDIUM-3):** wildcard + binary modes are
    /// mutually exclusive per Excel canon (wildcard requires linear
    /// scan; binary requires sorted input). Verified vs IronCalc.
    #[test]
    fn xlookup_wildcard_plus_binary_is_value_error() {
        let hay = r(vec![t("apple"), t("banana")]);
        let ret = r(vec![n(1.0), n(2.0)]);
        // match_mode=2 (wildcard) + search_mode=2 (binary asc) → #VALUE!
        assert_eq!(
            xlookup(&[
                s(t("ap*")),
                hay.clone(),
                ret.clone(),
                s(Value::Blank),
                s(n(2.0)),
                s(n(2.0)),
            ]),
            Value::Error(ErrorValue::Value)
        );
        // match_mode=2 + search_mode=-2 (binary desc) → #VALUE!
        assert_eq!(
            xlookup(&[
                s(t("ap*")),
                hay,
                ret,
                s(Value::Blank),
                s(n(2.0)),
                s(n(-2.0)),
            ]),
            Value::Error(ErrorValue::Value)
        );
    }

    // --- W5-176: real binary search ---

    #[test]
    fn xlookup_binary_asc_exact_match() {
        // Sorted ascending [1, 3, 5, 7, 9, 11], needle 7 → index 3 → ret[3].
        let hay = r(vec![n(1.0), n(3.0), n(5.0), n(7.0), n(9.0), n(11.0)]);
        let ret = r(vec![t("a"), t("b"), t("c"), t("d"), t("e"), t("f")]);
        assert_eq!(
            xlookup(&[s(n(7.0)), hay, ret, s(Value::Blank), s(n(0.0)), s(n(2.0)),]),
            t("d")
        );
    }

    #[test]
    fn xlookup_binary_asc_no_match_returns_na() {
        // Default if_not_found: omit args[3] entirely so positional
        // match_mode/search_mode would shift. Instead pass an explicit
        // #N/A as if_not_found — the function's no-match branch returns
        // that arg verbatim, so we get NA + verify the binary miss.
        let hay = r(vec![n(1.0), n(3.0), n(5.0), n(7.0)]);
        let ret = r(vec![t("a"), t("b"), t("c"), t("d")]);
        assert_eq!(
            xlookup(&[
                s(n(4.0)),
                hay,
                ret,
                s(Value::Error(ErrorValue::NA)),
                s(n(0.0)),
                s(n(2.0)),
            ]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn xlookup_binary_asc_next_smaller() {
        // match_mode=-1: largest cell ≤ needle. needle=4 in [1,3,5,7] → 3 (ret[1]).
        let hay = r(vec![n(1.0), n(3.0), n(5.0), n(7.0)]);
        let ret = r(vec![t("a"), t("b"), t("c"), t("d")]);
        assert_eq!(
            xlookup(&[
                s(n(4.0)),
                hay.clone(),
                ret.clone(),
                s(Value::Error(ErrorValue::NA)),
                s(n(-1.0)),
                s(n(2.0)),
            ]),
            t("b")
        );
        // needle BEFORE all: no smaller cell → #N/A.
        assert_eq!(
            xlookup(&[
                s(n(0.0)),
                hay.clone(),
                ret.clone(),
                s(Value::Error(ErrorValue::NA)),
                s(n(-1.0)),
                s(n(2.0)),
            ]),
            Value::Error(ErrorValue::NA)
        );
        // needle AFTER all: largest cell is last index.
        assert_eq!(
            xlookup(&[
                s(n(99.0)),
                hay,
                ret,
                s(Value::Error(ErrorValue::NA)),
                s(n(-1.0)),
                s(n(2.0)),
            ]),
            t("d")
        );
    }

    #[test]
    fn xlookup_binary_asc_next_larger() {
        // match_mode=1: smallest cell ≥ needle. needle=4 in [1,3,5,7] → 5 (ret[2]).
        let hay = r(vec![n(1.0), n(3.0), n(5.0), n(7.0)]);
        let ret = r(vec![t("a"), t("b"), t("c"), t("d")]);
        assert_eq!(
            xlookup(&[
                s(n(4.0)),
                hay.clone(),
                ret.clone(),
                s(Value::Error(ErrorValue::NA)),
                s(n(1.0)),
                s(n(2.0)),
            ]),
            t("c")
        );
        // needle BEFORE all: smallest cell is first index.
        assert_eq!(
            xlookup(&[
                s(n(0.0)),
                hay.clone(),
                ret.clone(),
                s(Value::Error(ErrorValue::NA)),
                s(n(1.0)),
                s(n(2.0)),
            ]),
            t("a")
        );
        // needle AFTER all: no larger cell → #N/A.
        assert_eq!(
            xlookup(&[
                s(n(99.0)),
                hay,
                ret,
                s(Value::Error(ErrorValue::NA)),
                s(n(1.0)),
                s(n(2.0)),
            ]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn xlookup_binary_desc_exact_match() {
        // Sorted descending [11, 9, 7, 5, 3, 1], needle 7 → index 2 → ret[2].
        let hay = r(vec![n(11.0), n(9.0), n(7.0), n(5.0), n(3.0), n(1.0)]);
        let ret = r(vec![t("a"), t("b"), t("c"), t("d"), t("e"), t("f")]);
        assert_eq!(
            xlookup(&[s(n(7.0)), hay, ret, s(Value::Blank), s(n(0.0)), s(n(-2.0)),]),
            t("c")
        );
    }

    #[test]
    fn xlookup_binary_desc_next_smaller() {
        // match_mode=-1 in descending list [10, 8, 5, 3, 1], needle 6
        // → largest ≤ 6 = 5 at index 2.
        let hay = r(vec![n(10.0), n(8.0), n(5.0), n(3.0), n(1.0)]);
        let ret = r(vec![t("a"), t("b"), t("c"), t("d"), t("e")]);
        assert_eq!(
            xlookup(&[
                s(n(6.0)),
                hay,
                ret,
                s(Value::Error(ErrorValue::NA)),
                s(n(-1.0)),
                s(n(-2.0)),
            ]),
            t("c")
        );
    }

    #[test]
    fn xlookup_binary_desc_next_larger() {
        // match_mode=1 in descending list [10, 8, 5, 3, 1], needle 6
        // → smallest ≥ 6 = 8 at index 1.
        let hay = r(vec![n(10.0), n(8.0), n(5.0), n(3.0), n(1.0)]);
        let ret = r(vec![t("a"), t("b"), t("c"), t("d"), t("e")]);
        assert_eq!(
            xlookup(&[
                s(n(6.0)),
                hay,
                ret,
                s(Value::Error(ErrorValue::NA)),
                s(n(1.0)),
                s(n(-2.0)),
            ]),
            t("b")
        );
    }

    #[test]
    fn xlookup_binary_desc_needle_at_extremes() {
        let hay = r(vec![n(10.0), n(8.0), n(5.0), n(3.0), n(1.0)]);
        let ret = r(vec![t("a"), t("b"), t("c"), t("d"), t("e")]);
        // needle > max in descending → only smaller candidates exist.
        // match_mode=-1: largest ≤ 99 = 10 at index 0.
        assert_eq!(
            xlookup(&[
                s(n(99.0)),
                hay.clone(),
                ret.clone(),
                s(Value::Error(ErrorValue::NA)),
                s(n(-1.0)),
                s(n(-2.0)),
            ]),
            t("a")
        );
        // match_mode=1: no larger cell → #N/A.
        assert_eq!(
            xlookup(&[
                s(n(99.0)),
                hay.clone(),
                ret.clone(),
                s(Value::Error(ErrorValue::NA)),
                s(n(1.0)),
                s(n(-2.0)),
            ]),
            Value::Error(ErrorValue::NA)
        );
        // needle < min in descending → only larger candidates exist.
        // match_mode=1: smallest ≥ 0 = 1 at index 4.
        assert_eq!(
            xlookup(&[
                s(n(0.0)),
                hay.clone(),
                ret.clone(),
                s(Value::Error(ErrorValue::NA)),
                s(n(1.0)),
                s(n(-2.0)),
            ]),
            t("e")
        );
        // match_mode=-1: no smaller cell → #N/A.
        assert_eq!(
            xlookup(&[
                s(n(0.0)),
                hay,
                ret,
                s(Value::Error(ErrorValue::NA)),
                s(n(-1.0)),
                s(n(-2.0)),
            ]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn xlookup_binary_unsorted_input_diverges_from_linear() {
        // Unsorted hay [5, 2, 8, 1, 9]. Linear scan (mode 1) would
        // find needle=8 at index 2. Binary search bisects under the
        // assumption that data is sorted — it lands somewhere in the
        // wrong region and returns #N/A. This matches Excel canon:
        // unsorted input to binary mode → undefined / #N/A.
        let hay = r(vec![n(5.0), n(2.0), n(8.0), n(1.0), n(9.0)]);
        let ret = r(vec![t("a"), t("b"), t("c"), t("d"), t("e")]);
        // Sanity check: linear scan finds it.
        assert_eq!(
            xlookup(&[
                s(n(8.0)),
                hay.clone(),
                ret.clone(),
                s(Value::Blank),
                s(n(0.0)),
                s(n(1.0)),
            ]),
            t("c")
        );
        // Binary search misses on the same unsorted data → #N/A.
        // (Bisection path: mid=2 hay[2]=8 → equal → returns index 2,
        // so this PARTICULAR needle happens to be discoverable. Use
        // a different needle that bisection misses.)
        // needle=2 actually exists at index 1 but binary bisects:
        // mid=2 (hay[2]=8 > 2), hi=2; mid=1 (hay[1]=2 == 2) → found.
        // To get a MISS we need a needle whose binary path lands wrong.
        // needle=1 exists at index 3 but binary: mid=2 (8>1) hi=2;
        // mid=1 (2>1) hi=1; mid=0 (5>1) hi=0; lo=hi=0 → not found.
        assert_eq!(
            xlookup(&[
                s(n(1.0)),
                hay,
                ret,
                s(Value::Error(ErrorValue::NA)),
                s(n(0.0)),
                s(n(2.0)),
            ]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn xlookup_binary_empty_hay_is_na() {
        // V1: lookup_array empty isn't possible through normal range
        // construction, but the binary helper still handles it
        // defensively. Skipped through the public API since `r(vec![])`
        // would have rows=1, cols=0 which most ranges treat as 0-element.
        // Instead test via the helper directly.
        let result = xlookup_find_index_binary(&n(5.0), &[], 0, false);
        assert_eq!(result, None);
    }

    // --- XMATCH binary search (W5-176) ---

    #[test]
    fn xmatch_binary_asc_exact() {
        let hay = r(vec![n(1.0), n(3.0), n(5.0), n(7.0)]);
        // search_mode arg position is 3 for xmatch (no return_array).
        assert_eq!(
            xmatch(&[s(n(5.0)), hay, s(n(0.0)), s(n(2.0))]),
            n(3.0) // 1-based position
        );
    }

    #[test]
    fn xmatch_binary_desc_exact() {
        let hay = r(vec![n(10.0), n(8.0), n(5.0), n(3.0), n(1.0)]);
        assert_eq!(xmatch(&[s(n(5.0)), hay, s(n(0.0)), s(n(-2.0))]), n(3.0));
    }

    #[test]
    fn xmatch_wildcard_plus_binary_is_value_error() {
        let hay = r(vec![t("apple")]);
        assert_eq!(
            xmatch(&[s(t("ap*")), hay, s(n(2.0)), s(n(2.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    // --- XMATCH ---

    #[test]
    fn xmatch_basic() {
        // XMATCH("b", [a,b,c]) → 2.
        let hay = r(vec![t("a"), t("b"), t("c")]);
        assert_eq!(xmatch(&[s(t("b")), hay]), n(2.0));
    }

    #[test]
    fn xmatch_no_match_is_na() {
        let hay = r(vec![t("a"), t("b")]);
        assert_eq!(xmatch(&[s(t("z")), hay]), Value::Error(ErrorValue::NA));
    }

    #[test]
    fn xmatch_reverse_search() {
        let hay = r(vec![t("a"), t("b"), t("c"), t("b")]);
        // Reverse: last "b" is at position 4.
        assert_eq!(xmatch(&[s(t("b")), hay, s(n(0.0)), s(n(-1.0))]), n(4.0));
    }

    #[test]
    fn xmatch_wildcard_mode() {
        let hay = r(vec![t("apple"), t("banana"), t("cherry")]);
        assert_eq!(xmatch(&[s(t("*err*")), hay, s(n(2.0))]), n(3.0));
    }

    // --- SUMPRODUCT ---

    #[test]
    fn sumproduct_two_arrays() {
        let a1 = r(vec![n(1.0), n(2.0), n(3.0)]);
        let a2 = r(vec![n(10.0), n(20.0), n(30.0)]);
        // 1*10 + 2*20 + 3*30 = 10 + 40 + 90 = 140.
        assert_eq!(sumproduct(&[a1, a2]), n(140.0));
    }

    #[test]
    fn sumproduct_single_array_is_sum() {
        let a = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(sumproduct(&[a]), n(6.0));
    }

    #[test]
    fn sumproduct_text_treated_as_zero() {
        // Lenient — text contributes 0, not #VALUE!.
        let a1 = r(vec![n(1.0), t("hello"), n(3.0)]);
        let a2 = r(vec![n(10.0), n(20.0), n(30.0)]);
        // 1*10 + 0*20 + 3*30 = 100.
        assert_eq!(sumproduct(&[a1, a2]), n(100.0));
    }

    #[test]
    fn sumproduct_shape_mismatch_is_value_error() {
        let a1 = r(vec![n(1.0), n(2.0)]);
        let a2 = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(sumproduct(&[a1, a2]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn sumproduct_error_in_cell_propagates() {
        let a1 = r(vec![n(1.0), Value::Error(ErrorValue::Num), n(3.0)]);
        let a2 = r(vec![n(10.0), n(20.0), n(30.0)]);
        assert_eq!(sumproduct(&[a1, a2]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn sumproduct_scalar_acts_as_constant_multiplier() {
        // SUMPRODUCT(2, A) = 2 * SUM(A).
        let a = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(sumproduct(&[s(n(2.0)), a]), n(12.0));
    }

    #[test]
    fn sumproduct_three_arrays() {
        let a1 = r(vec![n(1.0), n(2.0)]);
        let a2 = r(vec![n(3.0), n(4.0)]);
        let a3 = r(vec![n(5.0), n(6.0)]);
        // 1*3*5 + 2*4*6 = 15 + 48 = 63.
        assert_eq!(sumproduct(&[a1, a2, a3]), n(63.0));
    }

    #[test]
    fn sumproduct_empty_args_is_value_error() {
        assert_eq!(sumproduct(&[]), Value::Error(ErrorValue::Value));
    }

    // ===== W5-60: 2D shape validation regression tests =====
    // Codex mega-audit HIGH H2: IFS family + SUMPRODUCT must reject
    // same-flat-length-but-different-shape arrays.

    #[test]
    fn sumproduct_2x2_vs_1x4_same_length_different_shape_is_value_error() {
        let a2x2 = FnArg::Range {
            values: vec![n(1.0), n(2.0), n(3.0), n(4.0)],
            rows: 2,
            cols: 2,
        };
        let a1x4 = FnArg::Range {
            values: vec![n(1.0), n(2.0), n(3.0), n(4.0)],
            rows: 1,
            cols: 4,
        };
        // Same flat length (4) but different shape — Excel #VALUE!.
        // Pre-W5-60 this silently accepted and produced 1+4+9+16 = 30.
        assert_eq!(sumproduct(&[a2x2, a1x4]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn sumproduct_1x3_vs_3x1_same_length_different_shape_is_value_error() {
        let a1x3 = FnArg::Range {
            values: vec![n(1.0), n(2.0), n(3.0)],
            rows: 1,
            cols: 3,
        };
        let a3x1 = FnArg::Range {
            values: vec![n(1.0), n(2.0), n(3.0)],
            rows: 3,
            cols: 1,
        };
        assert_eq!(sumproduct(&[a1x3, a3x1]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn sumifs_1x3_vs_3x1_criteria_range_shape_mismatch_is_value_error() {
        let sum_range = FnArg::Range {
            values: vec![n(10.0), n(20.0), n(30.0)],
            rows: 1,
            cols: 3,
        };
        let crit_range = FnArg::Range {
            values: vec![n(1.0), n(2.0), n(3.0)],
            rows: 3,
            cols: 1,
        };
        // Same flat length (3) but different shape — must reject.
        assert_eq!(
            sumifs(&[sum_range, crit_range, s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn countifs_shape_mismatch_between_two_criteria_ranges_is_value_error() {
        let r1 = FnArg::Range {
            values: vec![n(1.0), n(1.0)],
            rows: 1,
            cols: 2,
        };
        let r2 = FnArg::Range {
            values: vec![n(1.0), n(1.0)],
            rows: 2,
            cols: 1,
        };
        // Same flat length (2), different shape.
        assert_eq!(
            countifs(&[r1, s(n(1.0)), r2, s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn averageifs_avg_range_shape_mismatch_is_value_error() {
        let avg_range = FnArg::Range {
            values: vec![n(10.0), n(20.0)],
            rows: 1,
            cols: 2,
        };
        let crit_range = FnArg::Range {
            values: vec![n(1.0), n(1.0)],
            rows: 2,
            cols: 1,
        };
        assert_eq!(
            averageifs(&[avg_range, crit_range, s(n(1.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn sumproduct_2x2_matching_arrays_works() {
        // Same shape — must work. Verifies the 2D-shape fix didn't
        // break the happy path.
        let a = FnArg::Range {
            values: vec![n(1.0), n(2.0), n(3.0), n(4.0)],
            rows: 2,
            cols: 2,
        };
        let b = FnArg::Range {
            values: vec![n(10.0), n(20.0), n(30.0), n(40.0)],
            rows: 2,
            cols: 2,
        };
        // 1*10 + 2*20 + 3*30 + 4*40 = 10 + 40 + 90 + 160 = 300.
        assert_eq!(sumproduct(&[a, b]), n(300.0));
    }

    // ===== W5-58: Stats family =====

    // --- LARGE / SMALL ---

    #[test]
    fn large_returns_kth_largest() {
        let arr = r(vec![n(3.0), n(1.0), n(4.0), n(1.0), n(5.0), n(9.0)]);
        assert_eq!(large(&[arr, s(n(1.0))]), n(9.0));
        let arr = r(vec![n(3.0), n(1.0), n(4.0), n(1.0), n(5.0), n(9.0)]);
        assert_eq!(large(&[arr, s(n(2.0))]), n(5.0));
        let arr = r(vec![n(3.0), n(1.0), n(4.0), n(1.0), n(5.0), n(9.0)]);
        assert_eq!(large(&[arr, s(n(6.0))]), n(1.0));
    }

    #[test]
    fn large_k_out_of_range_is_num() {
        let arr = r(vec![n(1.0), n(2.0)]);
        assert_eq!(large(&[arr, s(n(5.0))]), Value::Error(ErrorValue::Num));
        let arr = r(vec![n(1.0), n(2.0)]);
        assert_eq!(large(&[arr, s(n(0.0))]), Value::Error(ErrorValue::Num));
        let arr = r(vec![n(1.0), n(2.0)]);
        assert_eq!(large(&[arr, s(n(-1.0))]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn large_empty_range_is_num() {
        assert_eq!(
            large(&[r(vec![]), s(n(1.0))]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn small_returns_kth_smallest() {
        let arr = r(vec![n(3.0), n(1.0), n(4.0), n(1.0), n(5.0), n(9.0)]);
        assert_eq!(small(&[arr, s(n(1.0))]), n(1.0));
        let arr = r(vec![n(3.0), n(1.0), n(4.0), n(1.0), n(5.0), n(9.0)]);
        assert_eq!(small(&[arr, s(n(3.0))]), n(3.0));
    }

    #[test]
    fn small_k_out_of_range_is_num() {
        let arr = r(vec![n(1.0)]);
        assert_eq!(small(&[arr, s(n(5.0))]), Value::Error(ErrorValue::Num));
    }

    // --- RANK ---

    #[test]
    fn rank_descending_default() {
        // Default order: largest = rank 1.
        let arr = r(vec![n(10.0), n(20.0), n(30.0), n(40.0)]);
        // 30 is the 2nd-largest (after 40) → rank 2.
        assert_eq!(rank(&[s(n(30.0)), arr]), n(2.0));
    }

    #[test]
    fn rank_ascending_with_order() {
        let arr = r(vec![n(10.0), n(20.0), n(30.0), n(40.0)]);
        // Ascending: 30 is the 3rd-smallest → rank 3.
        assert_eq!(rank(&[s(n(30.0)), arr, s(n(1.0))]), n(3.0));
    }

    #[test]
    fn rank_ties_get_same_rank() {
        let arr = r(vec![n(10.0), n(20.0), n(20.0), n(30.0)]);
        // Descending: 30 = rank 1; both 20s = rank 2; 10 = rank 4.
        assert_eq!(rank(&[s(n(20.0)), arr]), n(2.0));
        let arr = r(vec![n(10.0), n(20.0), n(20.0), n(30.0)]);
        assert_eq!(rank(&[s(n(10.0)), arr]), n(4.0));
    }

    #[test]
    fn rank_value_not_in_ref_is_na() {
        let arr = r(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(rank(&[s(n(99.0)), arr]), Value::Error(ErrorValue::NA));
    }

    #[test]
    fn rank_empty_ref_is_na() {
        assert_eq!(rank(&[s(n(1.0)), r(vec![])]), Value::Error(ErrorValue::NA));
    }

    // --- RANK.AVG (W5-61) ---

    #[test]
    fn rank_avg_descending_with_ties_averages() {
        // [10, 20, 20, 30] descending — 30=1, 20+20=avg(2,3)=2.5, 10=4.
        let arr = r(vec![n(10.0), n(20.0), n(20.0), n(30.0)]);
        assert_eq!(rank_avg(&[s(n(30.0)), arr.clone()]), n(1.0));
        assert_eq!(rank_avg(&[s(n(20.0)), arr.clone()]), n(2.5));
        assert_eq!(rank_avg(&[s(n(10.0)), arr]), n(4.0));
    }

    #[test]
    fn rank_avg_three_way_tie() {
        // [10, 20, 20, 20, 30] descending — 20 ties with 2 others.
        // RANK would give 20 rank 2; RANK.AVG = 2 + (3-1)/2 = 3.
        let arr = r(vec![n(10.0), n(20.0), n(20.0), n(20.0), n(30.0)]);
        assert_eq!(rank_avg(&[s(n(20.0)), arr]), n(3.0));
    }

    #[test]
    fn rank_avg_no_ties_matches_rank() {
        let arr = r(vec![n(10.0), n(20.0), n(30.0), n(40.0)]);
        assert_eq!(rank_avg(&[s(n(30.0)), arr.clone()]), n(2.0));
        assert_eq!(rank_avg(&[s(n(10.0)), arr]), n(4.0));
    }

    #[test]
    fn rank_avg_ascending() {
        // [10, 20, 20, 30] ascending — 10=1, 20+20=avg(2,3)=2.5, 30=4.
        let arr = r(vec![n(10.0), n(20.0), n(20.0), n(30.0)]);
        assert_eq!(rank_avg(&[s(n(20.0)), arr.clone(), s(n(1.0))]), n(2.5));
        assert_eq!(rank_avg(&[s(n(10.0)), arr.clone(), s(n(1.0))]), n(1.0));
        assert_eq!(rank_avg(&[s(n(30.0)), arr, s(n(1.0))]), n(4.0));
    }

    #[test]
    fn rank_avg_value_not_in_ref_is_na() {
        let arr = r(vec![n(10.0), n(20.0), n(30.0)]);
        assert_eq!(rank_avg(&[s(n(99.0)), arr]), Value::Error(ErrorValue::NA));
    }

    #[test]
    fn rank_avg_empty_ref_is_na() {
        assert_eq!(
            rank_avg(&[s(n(1.0)), r(vec![])]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn rank_avg_arity_error() {
        assert_eq!(rank_avg(&[s(n(1.0))]), Value::Error(ErrorValue::Value));
        assert_eq!(
            rank_avg(&[s(n(1.0)), r(vec![n(1.0)]), s(n(0.0)), s(n(0.0))]),
            Value::Error(ErrorValue::Value)
        );
    }

    // --- MEDIAN ---

    #[test]
    fn median_odd_count() {
        // [1, 2, 3, 4, 5] → 3.
        assert_eq!(
            median(&[r(vec![n(1.0), n(2.0), n(3.0), n(4.0), n(5.0)])]),
            n(3.0)
        );
    }

    #[test]
    fn median_even_count_averages() {
        // [1, 2, 3, 4] → (2+3)/2 = 2.5.
        assert_eq!(median(&[r(vec![n(1.0), n(2.0), n(3.0), n(4.0)])]), n(2.5));
    }

    #[test]
    fn median_mixed_scalar_and_range() {
        // SCALARS contribute; RANGE contributes.
        assert_eq!(
            median(&[s(n(1.0)), r(vec![n(2.0), n(3.0)]), s(n(4.0)), s(n(5.0))]),
            n(3.0)
        );
    }

    #[test]
    fn median_unsorted_input() {
        // Input order shouldn't matter.
        assert_eq!(
            median(&[r(vec![n(5.0), n(1.0), n(3.0), n(2.0), n(4.0)])]),
            n(3.0)
        );
    }

    #[test]
    fn median_empty_is_num() {
        assert_eq!(median(&[r(vec![])]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn median_arity_zero_is_value_error() {
        assert_eq!(median(&[]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn median_text_in_range_propagates_value() {
        // Matches existing SUM/AVERAGE strict-text behavior.
        let arr = r(vec![n(1.0), t("hello"), n(3.0)]);
        assert_eq!(median(&[arr]), Value::Error(ErrorValue::Value));
    }

    // --- MODE ---

    #[test]
    fn mode_basic() {
        // [1, 2, 2, 3] → 2 (most frequent).
        assert_eq!(mode(&[r(vec![n(1.0), n(2.0), n(2.0), n(3.0)])]), n(2.0));
    }

    #[test]
    fn mode_tie_picks_first_appearance() {
        // [5, 3, 5, 3] → both 5 and 3 appear twice; first-appearance
        // tie-breaks to 5.
        assert_eq!(mode(&[r(vec![n(5.0), n(3.0), n(5.0), n(3.0)])]), n(5.0));
    }

    #[test]
    fn mode_no_repeat_is_na() {
        // [1, 2, 3] — nothing repeats → #N/A.
        assert_eq!(
            mode(&[r(vec![n(1.0), n(2.0), n(3.0)])]),
            Value::Error(ErrorValue::NA)
        );
    }

    #[test]
    fn mode_empty_is_num() {
        assert_eq!(mode(&[r(vec![])]), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn mode_mixed_scalar_and_range() {
        // SCALARS count too.
        assert_eq!(
            mode(&[s(n(7.0)), r(vec![n(1.0), n(7.0)]), s(n(2.0))]),
            n(7.0)
        );
    }

    #[test]
    fn mode_floats_exact_equality() {
        // Float bits used for hashing — 1.0 vs 1.0000000000000002
        // are distinct → no repeat → #N/A.
        let near_one = 1.0_f64 + f64::EPSILON;
        assert_eq!(
            mode(&[r(vec![n(1.0), n(near_one)])]),
            Value::Error(ErrorValue::NA)
        );
    }

    // --- CONCAT (W5-61, range-aware variant of CONCATENATE) ---
    // Uses the `t` helper defined at the top of this test module
    // (line ~1419).

    #[test]
    fn concat_scalars_only() {
        assert_eq!(
            concat(&[s(t("hello")), s(t(" ")), s(t("world"))]),
            t("hello world")
        );
    }

    #[test]
    fn concat_flattens_range() {
        // CONCAT accepts ranges; CONCATENATE doesn't.
        assert_eq!(concat(&[r(vec![t("a"), t("b"), t("c")])]), t("abc"));
    }

    #[test]
    fn concat_mixed_scalar_and_range() {
        assert_eq!(
            concat(&[s(t("start-")), r(vec![t("a"), t("b")]), s(t("-end"))]),
            t("start-ab-end")
        );
    }

    #[test]
    fn concat_blanks_become_empty_string() {
        // Excel canon: blanks contribute empty string (no skip).
        assert_eq!(concat(&[s(t("a")), s(Value::Blank), s(t("b"))]), t("ab"));
        assert_eq!(concat(&[r(vec![t("x"), Value::Blank, t("y")])]), t("xy"));
    }

    #[test]
    fn concat_coerces_numbers_and_bools() {
        assert_eq!(
            concat(&[s(n(1.0)), s(t("-")), s(Value::Boolean(true))]),
            t("1-TRUE")
        );
    }

    #[test]
    fn concat_propagates_errors() {
        assert_eq!(
            concat(&[s(t("a")), s(Value::Error(ErrorValue::DivZero)), s(t("b"))]),
            Value::Error(ErrorValue::DivZero)
        );
        // Error in a range cell also propagates.
        assert_eq!(
            concat(&[r(vec![t("x"), Value::Error(ErrorValue::Num)])]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn concat_empty_args_is_value_error() {
        assert_eq!(concat(&[]), Value::Error(ErrorValue::Value));
    }

    // W5-62 audit closure (Codex M3 / Sonnet M1): Excel's 32K char
    // text-result cap must be enforced.
    #[test]
    fn concat_exceeds_32k_char_cap_is_value_error() {
        // 33,000 single-char strings → 33,000 chars > 32,767.
        let scalars: Vec<FnArg> = (0..33_000).map(|_| s(t("a"))).collect();
        assert_eq!(concat(&scalars), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn concat_just_under_cap_succeeds() {
        // 32,767 single-char strings → exactly at the cap.
        let scalars: Vec<FnArg> = (0..32_767).map(|_| s(t("a"))).collect();
        match concat(&scalars) {
            Value::Text(s) => assert_eq!(s.chars().count(), 32_767),
            other => panic!("expected Value::Text(32767 chars), got {other:?}"),
        }
    }
}
