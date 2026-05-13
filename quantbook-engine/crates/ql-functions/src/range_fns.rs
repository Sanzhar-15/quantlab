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
}
