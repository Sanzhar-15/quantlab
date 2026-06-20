//! Array-returning function implementations.
//!
//! Phase 4.7.M (W5-106): the first wave of dynamic-array functions.
//! These functions register via `register_unified` and use the
//! `FunctionFn` ABI introduced in W5-96 (Phase 4.7.B), returning
//! `FunctionReturn::Array(_)` for the cell-boundary spill path.
//!
//! Per design doc § 6.2:
//! `docs/architecture/2026-05-14-array-formulas-and-spills.md`.
//!
//! ## Excel semantics
//!
//! At the cell boundary (the formula bar entry point), these return
//! arrays that the runtime materializes via `write_spill` into the
//! computed overlay. In any other context (sub-expression, scalar
//! arithmetic operand), the eval-site scalar dispatch surfaces the
//! return as `Value::Error(ErrorValue::Calc)` per design § 6.3 (Excel
//! 365's dynamic-array semantics; no implicit intersection in v1).
//!
//! ## Argument coercion
//!
//! `SEQUENCE(rows, cols?, start?, step?)` — all numeric args. Coerce
//! via the same lenient rules `scalar_fns` uses for scalar functions
//! (`to_number_lenient`): Numbers pass through, Booleans become 0/1,
//! text-that-parses-as-number coerces, anything else → `#VALUE!`.
//! `rows` and `cols` truncate toward zero (Excel canon) and must be
//! `>= 1`; otherwise the function returns a degenerate `ArrayValue`,
//! which the cell-boundary path surfaces as `#CALC!` per design § 8.1
//! step c.
//!
//! ## Bounds
//!
//! `rows * cols` is bounded by `u32::MAX` cells (the `ArrayValue`
//! capacity). The runtime spill writeback path additionally enforces
//! the workbook-grid bound (`MAX_ROW` / `MAX_COLUMN` at the anchor's
//! position).

use ql_types::{coercion, ArrayValue, ErrorValue, Value};

use crate::registry::{FunctionArg, FunctionContext, FunctionReturn};

/// Helper: coerce a `FunctionArg::Scalar` to an `f64` using the same
/// lenient rules `scalar_fns` uses internally. Non-Scalar args (Range,
/// Array) return `None` — they're not valid for SEQUENCE's numeric
/// parameter positions. Errors propagate as `None` so the caller can
/// surface them as a per-call return error.
///
/// `Value::Error` cases return `Some(Err(error))` so the caller can
/// propagate the SPECIFIC error (Excel canon: left-error-wins in arg
/// evaluation).
fn coerce_arg_to_f64(arg: &FunctionArg) -> Result<f64, Value> {
    match arg {
        FunctionArg::Scalar(v) => match v {
            Value::Error(e) => Err(Value::Error(*e)),
            other => match coercion::to_number_lenient(other) {
                Ok(n) => Ok(n),
                Err(e) => Err(Value::Error(e)),
            },
        },
        // Per Excel canon, passing a range/array to a scalar arg
        // position yields `#VALUE!` (legacy mode) or implicit
        // intersection (dynamic mode). v1 spec defers implicit
        // intersection (design § 6.3); surface `#VALUE!` for now.
        FunctionArg::Range { .. } | FunctionArg::Array(_) => Err(Value::Error(ErrorValue::Value)),
    }
}

/// `SEQUENCE(rows, [cols], [start], [step])` — generate a sequential
/// numeric array.
///
/// - `rows` (required): positive integer (truncated toward zero).
/// - `cols` (optional, default 1).
/// - `start` (optional, default 1.0).
/// - `step` (optional, default 1.0).
///
/// Result is a row-major `ArrayValue(rows, cols)` filled with
/// `start, start + step, start + 2*step, ...`.
///
/// Per design § 8.1 step c, a degenerate (`rows == 0 || cols == 0`)
/// result surfaces as `#CALC!` at the cell-boundary writeback;
/// SEQUENCE itself returns the degenerate `ArrayValue::empty(0, cols)`
/// (or empty rows, 0 cols) in those cases and lets the caller error
/// at the boundary. Negative `rows` / `cols` after truncation:
/// `#VALUE!` (Excel canon — can't have negative dimensions).
///
/// Arity validation: 1..=4 args; outside that range returns
/// `#N/A` (Excel canon for wrong-arity).
pub fn sequence(args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
    // Arity check.
    if args.is_empty() || args.len() > 4 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::NA));
    }

    // Coerce args. Left-error-wins: the first error arg's specific
    // error variant is what propagates.
    let rows_f = match coerce_arg_to_f64(&args[0]) {
        Ok(n) => n,
        Err(e) => return FunctionReturn::Scalar(e),
    };
    let cols_f = if args.len() >= 2 {
        match coerce_arg_to_f64(&args[1]) {
            Ok(n) => n,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        1.0
    };
    let start = if args.len() >= 3 {
        match coerce_arg_to_f64(&args[2]) {
            Ok(n) => n,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        1.0
    };
    let step = if args.len() >= 4 {
        match coerce_arg_to_f64(&args[3]) {
            Ok(n) => n,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        1.0
    };

    // Truncate rows/cols toward zero per Excel canon. NaN truncates
    // to 0; non-finite is rejected up front.
    if !rows_f.is_finite() || !cols_f.is_finite() {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
    }
    // **Codex audit MEDIUM closure**: reject negative dims BEFORE
    // truncation. `(-0.5).trunc()` is `-0.0` (sign-preserving), which
    // passes `< 0.0` (since `-0.0 < 0.0` is false). The post-trunc
    // check would then turn it into `0` and produce a misleading
    // degenerate-array (#CALC!) instead of the correct #VALUE! that
    // signals "negative dimension is wrong." Pre-trunc check catches
    // the (-1.0, 0.0) range correctly.
    if rows_f < 0.0 || cols_f < 0.0 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
    }
    let rows_trunc = rows_f.trunc();
    let cols_trunc = cols_f.trunc();

    // Bound by u32::MAX so cell-count doesn't overflow. Excel's actual
    // hard limit is 1M rows × 16K cols, but our grid-bound check at
    // write_spill catches that; here we just guard the multiplication.
    if rows_trunc > u32::MAX as f64 || cols_trunc > u32::MAX as f64 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
    }
    let rows = rows_trunc as u32;
    let cols = cols_trunc as u32;

    // **W5-108 (Phase 4.7.O) — Codex MEDIUM-2 closure**: design
    // § 13.1 specifies `SEQUENCE(0)` → `#NUM!` (and `cols < 1` → same).
    // Pre-fix returned a degenerate ArrayValue that the cell-boundary
    // mapped to `#CALC!`, a spec drift from Excel canon. Negativity
    // is already caught pre-trunc (returns `#VALUE!`); the remaining
    // zero-after-trunc case lands here.
    if rows == 0 || cols == 0 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
    }

    // Total cell count. Guard against rows*cols overflow even after
    // individual u32 bound check — the product could exceed usize on
    // 32-bit targets in theory; bound to a reasonable cap.
    let total = (rows as u64).saturating_mul(cols as u64);
    if total > (i32::MAX as u64) {
        // Heuristic ceiling: u32::MAX cells × 8 bytes = 32 GiB. Even
        // a 1M × 16K Excel grid is 16G cells. Capping at i32::MAX (~2.1G
        // cells) is generous for any realistic use; surface #NUM!
        // beyond that.
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
    }
    let total = total as usize;

    let mut cells: Vec<Value> = Vec::with_capacity(total);
    for i in 0..total {
        let v = start + (i as f64) * step;
        // Sanitize NaN/Inf per Excel canon. Step can underflow to NaN
        // if start is Inf etc.; we already rejected non-finite scalar
        // args above, but i*step at extreme values could still
        // produce non-finite results.
        if !v.is_finite() {
            cells.push(Value::Error(ErrorValue::Num));
        } else {
            cells.push(Value::Number(v));
        }
    }

    let arr = ArrayValue::new(rows, cols, cells)
        .expect("rows*cols == total; ArrayValue::new must succeed");
    FunctionReturn::Array(arr)
}

/// **W5-107 (Phase 4.7.N) — TRANSPOSE.** Swap rows ↔ cols. Per
/// design § 11 and Excel canon.
///
/// `TRANSPOSE(array)` — single arg, returns a transposed `ArrayValue`
/// where `result.at(j, i) = array.at(i, j)`. Result shape is
/// `(cols, rows)`.
///
/// Arg shapes:
/// - `FunctionArg::Array(a)` → transpose `a`.
/// - `FunctionArg::Range { values, rows, cols }` — treat as a 2D
///   array, transpose it. Range arg position acts identically to
///   Array here (read-only over the cell values).
/// - `FunctionArg::Scalar(Value::Error(_))` → propagate (left-error
///   contract).
/// - `FunctionArg::Scalar(other)` → 1×1 transpose = 1×1 same value
///   (Excel: a scalar is implicitly a 1×1 array; TRANSPOSE of 1×1 is
///   1×1 unchanged).
///
/// Arity: exactly 1 arg. 0 or ≥ 2 → `#N/A`.
///
/// Degenerate input (`rows == 0 || cols == 0`) → degenerate output of
/// the swapped shape. Cell-boundary writeback surfaces `#CALC!` per
/// design § 8.1 step c.
pub fn transpose(args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
    if args.len() != 1 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::NA));
    }

    let (in_rows, in_cols, cells): (u32, u32, Vec<Value>) = match &args[0] {
        FunctionArg::Scalar(Value::Error(e)) => {
            return FunctionReturn::Scalar(Value::Error(*e));
        }
        FunctionArg::Scalar(v) => {
            // Excel canon: scalar is implicitly 1×1. TRANSPOSE keeps shape.
            return FunctionReturn::Array(ArrayValue::singleton(v.clone()));
        }
        FunctionArg::Array(a) => {
            // Materialize cell vec; ArrayValue exposes row-major slice
            // via `cells()`. Clone is the simplest path; an in-place
            // permutation would save a copy but adds complexity for
            // little gain on realistic sizes.
            (a.rows(), a.cols(), a.cells().to_vec())
        }
        FunctionArg::Range { values, rows, cols } => {
            // Range carries explicit (rows, cols) per the unified ABI.
            // Bound to u32 for the ArrayValue API.
            if *rows > u32::MAX as usize || *cols > u32::MAX as usize {
                return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
            }
            (*rows as u32, *cols as u32, values.clone())
        }
    };

    // Degenerate input → degenerate transposed output (swapped shape).
    // ArrayValue::empty constructs the (rows, cols) variant with no
    // cells; the cell-boundary path surfaces this as `#CALC!`.
    if in_rows == 0 || in_cols == 0 {
        return FunctionReturn::Array(ArrayValue::empty(in_cols, in_rows));
    }

    // Allocate the output cell vec. Output has (in_cols, in_rows)
    // shape; `result_cells[j * in_rows + i] = cells[i * in_cols + j]`.
    let total = (in_rows as usize) * (in_cols as usize);
    let mut result_cells: Vec<Value> = Vec::with_capacity(total);
    // Iterate output row-major: outer loop over new rows j (was cols),
    // inner over new cols i (was rows).
    for j in 0..in_cols {
        for i in 0..in_rows {
            let src_idx = (i as usize) * (in_cols as usize) + (j as usize);
            result_cells.push(cells[src_idx].clone());
        }
    }
    let arr = ArrayValue::new(in_cols, in_rows, result_cells)
        .expect("rows*cols == total; ArrayValue::new must succeed");
    FunctionReturn::Array(arr)
}

/// Helper: extract the (rows, cols, cells) triple from an Array or
/// Range arg shape. Scalar args become 1×1. Error args bubble up via
/// `Err`. Used by FILTER for both its `array` and `include` args.
fn arg_as_2d(arg: &FunctionArg) -> Result<(u32, u32, Vec<Value>), Value> {
    match arg {
        FunctionArg::Scalar(Value::Error(e)) => Err(Value::Error(*e)),
        FunctionArg::Scalar(v) => Ok((1, 1, vec![v.clone()])),
        FunctionArg::Array(a) => Ok((a.rows(), a.cols(), a.cells().to_vec())),
        FunctionArg::Range { values, rows, cols } => {
            if *rows > u32::MAX as usize || *cols > u32::MAX as usize {
                return Err(Value::Error(ErrorValue::Num));
            }
            Ok((*rows as u32, *cols as u32, values.clone()))
        }
    }
}

/// **W5-107 (Phase 4.7.N.2) — FILTER.** Subset of `array` rows (or
/// cols) where the corresponding `include` value is truthy.
///
/// `FILTER(array, include, [if_empty])`.
///
/// v1 contract — 1D only. `array` and `include` must both be:
/// - row-vector (rows == 1, cols == N), OR
/// - column-vector (rows == N, cols == 1).
///
/// Both must share the same orientation AND length. 2D `array`
/// filtering (where include is per-row or per-col) is Excel canon but
/// deferred to v2 (would need an orientation discriminator).
///
/// Truthy rules (Excel canon):
/// - Number != 0 → truthy.
/// - Boolean(true) → truthy.
/// - Boolean(false), Number(0), Blank → falsy.
/// - Text → not allowed; surface `#VALUE!` (Excel actually accepts
///   text in some locales but our coercion is consistent with how
///   SUMIF/etc. handle conditions; defer locale-permissive coercion).
/// - Error in include cell → propagate.
///
/// Arity: 2 or 3. Wrong → `#N/A`.
///
/// Outcomes:
/// - At least one include truthy → result vector with matching shape
///   (row-of-N → row-of-K; column-of-N → column-of-K, where K is the
///   truthy count).
/// - All-false + `if_empty` provided → 1×1 ArrayValue of if_empty.
/// - All-false + no `if_empty` → degenerate ArrayValue
///   (cell-boundary path surfaces as `#CALC!`).
/// - Shape mismatch (orientation or length) → `#VALUE!`.
/// - Error in `array` or `include` cell → first error wins, propagate.
pub fn filter(args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
    if args.len() < 2 || args.len() > 3 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::NA));
    }

    let (a_rows, a_cols, a_cells) = match arg_as_2d(&args[0]) {
        Ok(t) => t,
        Err(e) => return FunctionReturn::Scalar(e),
    };
    let (i_rows, i_cols, i_cells) = match arg_as_2d(&args[1]) {
        Ok(t) => t,
        Err(e) => return FunctionReturn::Scalar(e),
    };

    // v1 — 1D shape required. Determine orientation:
    // row-vector: rows == 1 AND cols >= 1.
    // column-vector: cols == 1 AND rows >= 1.
    // Anything else (2D or degenerate) → #VALUE!.
    let (is_row_vec, length): (bool, u32) = if a_rows == 1 && a_cols >= 1 {
        (true, a_cols)
    } else if a_cols == 1 && a_rows >= 1 {
        (false, a_rows)
    } else {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
    };

    // include must match orientation + length.
    let include_matches_shape = if is_row_vec {
        i_rows == 1 && i_cols == length
    } else {
        i_cols == 1 && i_rows == length
    };
    if !include_matches_shape {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
    }

    // Walk include cells, building the result. Truthy decision:
    // - Error → propagate immediately (left-error wins).
    // - Number NaN → #NUM! (IEEE NaN can't be coerced; `!= 0.0` is
    //   true for NaN, so without this guard FILTER would silently
    //   keep NaN-masked rows). W5-107-AUDIT Sonnet LOW closure.
    // - Number != 0 → truthy.
    // - Boolean(true) → truthy.
    // - Boolean(false), Number(0), Blank → falsy.
    // - Text → #VALUE!.
    let mut kept: Vec<Value> = Vec::with_capacity(length as usize);
    for (idx, include_v) in i_cells.iter().enumerate() {
        let truthy = match include_v {
            Value::Error(e) => return FunctionReturn::Scalar(Value::Error(*e)),
            Value::Number(n) if n.is_nan() => {
                return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
            }
            Value::Number(n) => *n != 0.0,
            Value::Boolean(b) => *b,
            Value::Blank => false,
            Value::Text(_) => {
                return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
            }
        };
        if truthy {
            // idx < length == a_cells.len() by construction (we
            // checked include_matches_shape above). Use [] with
            // a tight invariant comment instead of `.get()` to
            // avoid a silently-skipped branch on bug. W5-107-AUDIT
            // Sonnet LOW closure.
            let cell = &a_cells[idx];
            // Per Excel canon, an Error in the data array surfaces
            // as a per-cell error in the result (not propagated
            // as the whole return). FILTER preserves whatever is
            // in the kept cells.
            kept.push(cell.clone());
        }
    }

    // All-false case.
    if kept.is_empty() {
        if args.len() == 3 {
            // if_empty provided — 1×1 with that value.
            // W5-107-AUDIT Sonnet LOW closure: guard against
            // degenerate Array/Range inputs (rows==0 or cols==0)
            // — `ArrayValue::first()` panics on them. Surface a
            // degenerate result instead so cell-boundary maps it
            // to #CALC!, matching the no-if_empty path.
            let if_empty_v = match &args[2] {
                FunctionArg::Scalar(v) => Some(v.clone()),
                FunctionArg::Array(a) => {
                    if a.rows() == 0 || a.cols() == 0 {
                        None
                    } else {
                        Some(a.first().clone())
                    }
                }
                FunctionArg::Range { values, .. } => values.first().cloned(),
            };
            if let Some(v) = if_empty_v {
                return FunctionReturn::Array(ArrayValue::singleton(v));
            }
            // Degenerate if_empty falls through to the degenerate
            // output path below.
        }
        // No if_empty (or degenerate if_empty) — degenerate output.
        // Cell-boundary surfaces #CALC!.
        let degen_shape = if is_row_vec { (1, 0) } else { (0, 1) };
        return FunctionReturn::Array(ArrayValue::empty(degen_shape.0, degen_shape.1));
    }

    // Non-empty result. Shape preserves orientation.
    let k = kept.len() as u32;
    let (out_rows, out_cols) = if is_row_vec { (1, k) } else { (k, 1) };
    let arr = ArrayValue::new(out_rows, out_cols, kept)
        .expect("kept.len() == rows*cols; ArrayValue::new must succeed");
    FunctionReturn::Array(arr)
}

// ───────────────────────── Wave O (2026-06-20) ──────────────────────────────
// SORT / SORTBY / UNIQUE / RANDARRAY — completing the "top-5" dynamic-array
// family (SEQUENCE / TRANSPOSE / FILTER already ship above).

use std::cmp::Ordering;

/// Coerce a `FunctionArg::Scalar` to a boolean using Excel's lenient flag
/// rules (TRUE/FALSE, or a number where `!= 0` is true). Used for the
/// `by_col` / `exactly_once` / `whole_number` flag positions. Non-scalar args
/// or non-coercible text surface `#VALUE!`; an error arg propagates.
fn coerce_arg_to_bool(arg: &FunctionArg) -> Result<bool, Value> {
    match arg {
        FunctionArg::Scalar(Value::Boolean(b)) => Ok(*b),
        FunctionArg::Scalar(Value::Number(n)) => Ok(*n != 0.0),
        FunctionArg::Scalar(Value::Blank) => Ok(false),
        FunctionArg::Scalar(Value::Error(e)) => Err(Value::Error(*e)),
        // Text / range / array at a flag position is not a valid boolean.
        FunctionArg::Scalar(Value::Text(_)) | FunctionArg::Range { .. } | FunctionArg::Array(_) => {
            Err(Value::Error(ErrorValue::Value))
        }
    }
}

/// Excel SORT total-order rank: Number/Blank < Text < Boolean < Error. Within
/// a rank, [`sort_cmp`] resolves the fine order.
///
/// **v1 simplification (megaudit-flagged):** Excel pushes truly-empty cells to
/// the END of a sorted range regardless of direction. Our engine carries Blank
/// as a first-class value; matching `lookup_cmp` (range_fns.rs) we treat Blank
/// as `0` and let it sort among numbers. "Blanks always last" is deferred to
/// v1.5 (it needs a direction-independent partition, not a total order).
fn sort_type_rank(v: &Value) -> u8 {
    match v {
        Value::Number(_) | Value::Blank => 0,
        Value::Text(_) => 1,
        Value::Boolean(_) => 2,
        Value::Error(_) => 3,
    }
}

/// Total order over `Value` for SORT/SORTBY (ascending). Cross-type order is by
/// [`sort_type_rank`]; within a type: numbers/blanks numerically (Blank == 0),
/// text case-insensitively (uppercase fold, matching `lookup_cmp`), booleans
/// FALSE < TRUE, and all errors compare Equal (grouped; stable sort keeps their
/// original order).
///
/// **Megaudit (2026-06-20):** this MUST be a strict-weak-ordering — `slice::sort_by`
/// has unspecified output (never UB, but a garbage permutation) if it is not. The
/// engine sanitizes NaN to `#NUM!`, so a raw `Value::Number(NaN)` should never reach
/// here, but a `partial_cmp(...).unwrap_or(Equal)` would make `NaN == 1` and `NaN ==
/// 2` while `1 < 2` (a transitivity break). We give NaN a deterministic place
/// (NaN > every real number; NaN == NaN) so the comparator is a total order for ANY
/// f64 input, defensively.
fn sort_cmp(a: &Value, b: &Value) -> Ordering {
    let (ra, rb) = (sort_type_rank(a), sort_type_rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    match (a, b) {
        (Value::Number(_) | Value::Blank, Value::Number(_) | Value::Blank) => {
            let na = if let Value::Number(n) = a { *n } else { 0.0 };
            let nb = if let Value::Number(n) = b { *n } else { 0.0 };
            // Deterministic total order incl. NaN (sorts after every real; NaN == NaN).
            match (na.is_nan(), nb.is_nan()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => na.partial_cmp(&nb).expect("non-NaN f64 compare is total"),
            }
        }
        (Value::Text(x), Value::Text(y)) => x.to_uppercase().cmp(&y.to_uppercase()),
        (Value::Boolean(x), Value::Boolean(y)) => x.cmp(y),
        // Errors group together; stable sort preserves their input order.
        _ => Ordering::Equal,
    }
}

/// Value equality for UNIQUE dedup: same-type only — numbers by `==` (NaN never
/// equal, so each NaN row is distinct), text case-insensitively (matching
/// `sort_cmp`), booleans / blanks / matching error variants. Cross-type is
/// never equal (`0 != FALSE != "" != Blank`), matching Excel's UNIQUE.
fn values_equal_for_unique(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y,
        (Value::Text(x), Value::Text(y)) => x.to_uppercase() == y.to_uppercase(),
        (Value::Boolean(x), Value::Boolean(y)) => x == y,
        (Value::Blank, Value::Blank) => true,
        (Value::Error(x), Value::Error(y)) => x == y,
        _ => false,
    }
}

/// Coerce a scalar arg to a `1`/`-1` sort-order direction. Excel: `1`
/// (ascending, default) or `-1` (descending); anything else → `#VALUE!`.
fn coerce_sort_order(arg: &FunctionArg) -> Result<bool, Value> {
    // Returns `descending` (true = -1, false = 1).
    match coerce_arg_to_f64(arg) {
        Ok(n) if n == 1.0 => Ok(false),
        Ok(n) if n == -1.0 => Ok(true),
        Ok(_) => Err(Value::Error(ErrorValue::Value)),
        Err(e) => Err(e),
    }
}

/// `SORT(array, [sort_index], [sort_order], [by_col])` — reorder the rows (or,
/// with `by_col` TRUE, the columns) of `array` by the key column/row at the
/// 1-based `sort_index`. Stable (Excel 365 keeps ties in input order, both
/// directions). Shape is preserved.
///
/// - `sort_index` (default 1): 1-based key column (by_col FALSE) or key row
///   (by_col TRUE). Out of range → `#VALUE!`.
/// - `sort_order` (default 1): 1 ascending, -1 descending; else `#VALUE!`.
/// - `by_col` (default FALSE): FALSE sorts rows, TRUE sorts columns.
///
/// Arity 1..=4 → else `#N/A`. Degenerate input → degenerate output (`#CALC!`).
pub fn sort(args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
    if args.is_empty() || args.len() > 4 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::NA));
    }
    let (rows, cols, cells) = match arg_as_2d(&args[0]) {
        Ok(t) => t,
        Err(e) => return FunctionReturn::Scalar(e),
    };
    // sort_index (1-based) defaults to 1.
    let sort_index = if args.len() >= 2 {
        match coerce_arg_to_f64(&args[1]) {
            Ok(n) if n.is_finite() && n >= 1.0 => n.trunc() as u64,
            Ok(_) => return FunctionReturn::Scalar(Value::Error(ErrorValue::Value)),
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        1
    };
    let descending = if args.len() >= 3 {
        match coerce_sort_order(&args[2]) {
            Ok(d) => d,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        false
    };
    let by_col = if args.len() >= 4 {
        match coerce_arg_to_bool(&args[3]) {
            Ok(b) => b,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        false
    };

    // Degenerate input → degenerate output of the same shape (#CALC!).
    if rows == 0 || cols == 0 {
        return FunctionReturn::Array(ArrayValue::empty(rows, cols));
    }

    // The key axis length must contain `sort_index`.
    let key_axis_len = if by_col { rows } else { cols };
    if sort_index > key_axis_len as u64 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
    }
    let key_idx = (sort_index - 1) as usize;
    let cells_at = |r: usize, c: usize| -> &Value { &cells[r * (cols as usize) + c] };

    if !by_col {
        // Sort rows by the key column `key_idx`. Stable.
        let mut order: Vec<usize> = (0..rows as usize).collect();
        order.sort_by(|&r1, &r2| {
            let o = sort_cmp(cells_at(r1, key_idx), cells_at(r2, key_idx));
            if descending {
                o.reverse()
            } else {
                o
            }
        });
        let mut out: Vec<Value> = Vec::with_capacity(cells.len());
        for &r in &order {
            for c in 0..cols as usize {
                out.push(cells_at(r, c).clone());
            }
        }
        let arr = ArrayValue::new(rows, cols, out).expect("row permutation preserves cell count");
        FunctionReturn::Array(arr)
    } else {
        // Sort columns by the key row `key_idx`. Stable.
        let mut order: Vec<usize> = (0..cols as usize).collect();
        order.sort_by(|&c1, &c2| {
            let o = sort_cmp(cells_at(key_idx, c1), cells_at(key_idx, c2));
            if descending {
                o.reverse()
            } else {
                o
            }
        });
        let mut out: Vec<Value> = Vec::with_capacity(cells.len());
        for r in 0..rows as usize {
            for &c in &order {
                out.push(cells_at(r, c).clone());
            }
        }
        let arr = ArrayValue::new(rows, cols, out).expect("col permutation preserves cell count");
        FunctionReturn::Array(arr)
    }
}

/// `SORTBY(array, by_array1, [order1], [by_array2, order2], …)` — reorder
/// `array`'s rows (or columns) by one or more parallel key vectors. Stable,
/// multi-key (by_array1 primary). Shape is preserved.
///
/// Args after `array` are parsed by TYPE (Excel's disambiguation): an
/// array/range is a new `by_array`; a scalar number is the `order` (1/-1) for
/// the most-recent `by_array`. `by_array1` is required.
///
/// **v1 contract:** every `by_array` is a 1D vector (column OR row) sharing the
/// SAME orientation and length, which selects the sort axis — a column vector
/// of length `array.rows` sorts rows; a row vector of length `array.cols` sorts
/// columns. Mismatched orientation/length → `#VALUE!`.
pub fn sortby(args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
    if args.len() < 2 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::NA));
    }
    let (rows, cols, cells) = match arg_as_2d(&args[0]) {
        Ok(t) => t,
        Err(e) => return FunctionReturn::Scalar(e),
    };

    // Parse the (by_array, order) sequence by arg type.
    struct Key {
        rows: u32,
        cols: u32,
        cells: Vec<Value>,
        descending: bool,
    }
    let mut keys: Vec<Key> = Vec::new();
    let mut order_set_for_last = false; // guard: one order per by_array.
    for arg in &args[1..] {
        match arg {
            FunctionArg::Array(_) | FunctionArg::Range { .. } => {
                let (kr, kc, kcells) = match arg_as_2d(arg) {
                    Ok(t) => t,
                    Err(e) => return FunctionReturn::Scalar(e),
                };
                keys.push(Key {
                    rows: kr,
                    cols: kc,
                    cells: kcells,
                    descending: false,
                });
                order_set_for_last = false;
            }
            FunctionArg::Scalar(Value::Error(e)) => {
                return FunctionReturn::Scalar(Value::Error(*e));
            }
            FunctionArg::Scalar(_) => {
                // A scalar is an order for the most-recent by_array.
                if keys.is_empty() || order_set_for_last {
                    return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
                }
                match coerce_sort_order(arg) {
                    Ok(d) => keys.last_mut().unwrap().descending = d,
                    Err(e) => return FunctionReturn::Scalar(e),
                }
                order_set_for_last = true;
            }
        }
    }
    if keys.is_empty() {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::NA));
    }

    if rows == 0 || cols == 0 {
        return FunctionReturn::Array(ArrayValue::empty(rows, cols));
    }

    // Orientation from the FIRST key: column vector → sort rows; row vector →
    // sort columns. Every other key must match orientation + length.
    let (sort_rows, axis_len): (bool, u32) = {
        let k = &keys[0];
        if k.cols == 1 && k.rows == rows {
            (true, rows)
        } else if k.rows == 1 && k.cols == cols {
            (false, cols)
        } else {
            return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
        }
    };
    for k in &keys {
        let ok = if sort_rows {
            k.cols == 1 && k.rows == axis_len
        } else {
            k.rows == 1 && k.cols == axis_len
        };
        if !ok {
            return FunctionReturn::Scalar(Value::Error(ErrorValue::Value));
        }
    }

    // Stable multi-key sort of the axis indices.
    let mut order: Vec<usize> = (0..axis_len as usize).collect();
    order.sort_by(|&i, &j| {
        for k in &keys {
            let o = sort_cmp(&k.cells[i], &k.cells[j]);
            let o = if k.descending { o.reverse() } else { o };
            if o != Ordering::Equal {
                return o;
            }
        }
        Ordering::Equal
    });

    let cells_at = |r: usize, c: usize| -> &Value { &cells[r * (cols as usize) + c] };
    let mut out: Vec<Value> = Vec::with_capacity(cells.len());
    if sort_rows {
        for &r in &order {
            for c in 0..cols as usize {
                out.push(cells_at(r, c).clone());
            }
        }
    } else {
        for r in 0..rows as usize {
            for &c in &order {
                out.push(cells_at(r, c).clone());
            }
        }
    }
    let arr = ArrayValue::new(rows, cols, out).expect("permutation preserves cell count");
    FunctionReturn::Array(arr)
}

/// `UNIQUE(array, [by_col], [exactly_once])` — distinct rows (or, with `by_col`
/// TRUE, distinct columns) of `array`, in first-seen order.
///
/// - `by_col` (default FALSE): FALSE compares whole rows, TRUE whole columns.
/// - `exactly_once` (default FALSE): FALSE returns each distinct entry once;
///   TRUE returns only entries that appear EXACTLY once.
///
/// Equality is element-wise [`values_equal_for_unique`] (case-insensitive text,
/// cross-type distinct). Arity 1..=3 → else `#N/A`. An all-duplicate result
/// under `exactly_once`, or degenerate input, → degenerate output (`#CALC!`).
pub fn unique(args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
    if args.is_empty() || args.len() > 3 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::NA));
    }
    let (rows, cols, cells) = match arg_as_2d(&args[0]) {
        Ok(t) => t,
        Err(e) => return FunctionReturn::Scalar(e),
    };
    let by_col = if args.len() >= 2 {
        match coerce_arg_to_bool(&args[1]) {
            Ok(b) => b,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        false
    };
    let exactly_once = if args.len() >= 3 {
        match coerce_arg_to_bool(&args[2]) {
            Ok(b) => b,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        false
    };

    if rows == 0 || cols == 0 {
        return FunctionReturn::Array(ArrayValue::empty(rows, cols));
    }
    let (rows_u, cols_u) = (rows as usize, cols as usize);
    let cells_at = |r: usize, c: usize| -> &Value { &cells[r * cols_u + c] };

    // `n` entries along the dedup axis; each entry has `width` elements.
    let (n, width): (usize, usize) = if by_col {
        (cols_u, rows_u)
    } else {
        (rows_u, cols_u)
    };
    // Read entry `e`'s element `k` (k indexes the cross axis).
    let entry_elem = |e: usize, k: usize| -> &Value {
        if by_col {
            cells_at(k, e) // column e, row k
        } else {
            cells_at(e, k) // row e, col k
        }
    };
    let entries_equal = |a: usize, b: usize| -> bool {
        (0..width).all(|k| values_equal_for_unique(entry_elem(a, k), entry_elem(b, k)))
    };

    // First-seen distinct entries + occurrence counts (O(n^2) compare — matches
    // the codebase's "linear/simple, revisit if perf shows" idiom for lookups).
    let mut distinct: Vec<usize> = Vec::new();
    let mut counts: Vec<usize> = Vec::new();
    for e in 0..n {
        if let Some(pos) = distinct.iter().position(|&d| entries_equal(d, e)) {
            counts[pos] += 1;
        } else {
            distinct.push(e);
            counts.push(1);
        }
    }

    let kept: Vec<usize> = distinct
        .iter()
        .zip(counts.iter())
        .filter(|(_, &c)| !exactly_once || c == 1)
        .map(|(&e, _)| e)
        .collect();

    if kept.is_empty() {
        // No qualifying entry → degenerate of the result shape (#CALC!).
        let (dr, dc) = if by_col { (rows, 0) } else { (0, cols) };
        return FunctionReturn::Array(ArrayValue::empty(dr, dc));
    }

    let k = kept.len() as u32;
    let (out_rows, out_cols) = if by_col { (rows, k) } else { (k, cols) };
    let mut out: Vec<Value> = Vec::with_capacity((out_rows as usize) * (out_cols as usize));
    if by_col {
        // Result columns = kept columns, in first-seen order; row-major fill.
        for r in 0..rows_u {
            for &e in &kept {
                out.push(cells_at(r, e).clone());
            }
        }
    } else {
        for &e in &kept {
            for c in 0..cols_u {
                out.push(cells_at(e, c).clone());
            }
        }
    }
    let arr = ArrayValue::new(out_rows, out_cols, out).expect("kept entries fill the result shape");
    FunctionReturn::Array(arr)
}

/// `RANDARRAY([rows], [cols], [min], [max], [whole_number])` — an array of
/// random numbers. **Volatile** (re-rolls every recalc); deterministic under
/// `volatile::set_test_rng_seed` (shares RAND's thread-local RNG).
///
/// - `rows` / `cols` (default 1): like SEQUENCE — finite, negative → `#VALUE!`,
///   zero → `#NUM!`, truncated toward zero.
/// - `min` / `max` (default 0 / 1): the continuous bound. **v1 divergence
///   (megaudit-noted):** the interval is `[min, max)` (exclusive-max), since the
///   draw reuses RAND's `[0, 1)`; Excel documents `[min, max]` inclusive. The gap
///   is unobservable in practice (P(hit max) ≈ 2⁻⁵³). `min > max` → `#NUM!`; a
///   non-finite span (`1e308 - -1e308`) → `#NUM!`.
/// - `whole_number` (default FALSE): TRUE returns integers in `[ceil(min),
///   floor(max)]` inclusive (mirroring RANDBETWEEN's rounding); if
///   `ceil(min) > floor(max)`, or a bound is outside the i64 integer domain →
///   `#NUM!` (never a panic).
///
/// Arity 0..=5 → else `#N/A`. (v1 bound choices — `min > max` → `#NUM!`, and
/// whole-number rounding via ceil/floor — are megaudit-flagged for Excel-canon
/// confirmation.)
pub fn randarray(args: &[FunctionArg], _ctx: &FunctionContext) -> FunctionReturn {
    if args.len() > 5 {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::NA));
    }
    // Dimension coercion mirrors SEQUENCE exactly.
    let dim = |idx: usize| -> Result<u32, Value> {
        let f = coerce_arg_to_f64(&args[idx])?;
        if !f.is_finite() {
            return Err(Value::Error(ErrorValue::Value));
        }
        if f < 0.0 {
            return Err(Value::Error(ErrorValue::Value));
        }
        let t = f.trunc();
        if t > u32::MAX as f64 {
            return Err(Value::Error(ErrorValue::Num));
        }
        let d = t as u32;
        if d == 0 {
            return Err(Value::Error(ErrorValue::Num));
        }
        Ok(d)
    };
    let rows = if args.len() >= 1 {
        match dim(0) {
            Ok(d) => d,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        1
    };
    let cols = if args.len() >= 2 {
        match dim(1) {
            Ok(d) => d,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        1
    };
    let min = if args.len() >= 3 {
        match coerce_arg_to_f64(&args[2]) {
            Ok(n) if n.is_finite() => n,
            Ok(_) => return FunctionReturn::Scalar(Value::Error(ErrorValue::Num)),
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        0.0
    };
    let max = if args.len() >= 4 {
        match coerce_arg_to_f64(&args[3]) {
            Ok(n) if n.is_finite() => n,
            Ok(_) => return FunctionReturn::Scalar(Value::Error(ErrorValue::Num)),
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        1.0
    };
    let whole = if args.len() >= 5 {
        match coerce_arg_to_bool(&args[4]) {
            Ok(b) => b,
            Err(e) => return FunctionReturn::Scalar(e),
        }
    } else {
        false
    };

    // **Codex megaudit HIGH/MEDIUM (2026-06-20):** validate the value bounds BEFORE the dimension
    // allocation, and bound them so the integer/continuous draw can never panic or poison. Two
    // failure classes the naive ordering hit: (1) `RANDARRAY(2147483647,1,10,5)` would allocate ~2.1B
    // cells before noticing min>max; (2) `RANDARRAY(1,1,-1E20,1E20,TRUE)` overflowed `i64` in the
    // whole-number span, and `RANDARRAY(1,1,-1E308,1E308)` produced a non-finite continuous span.
    // Resolve EVERY bound to a fill closure (or a `#NUM!`) up front, THEN allocate.
    enum Draw {
        Whole(i64, i64),
        Continuous(f64, f64), // (min, span); span guaranteed finite
    }
    let draw = if whole {
        let lo = min.ceil();
        let hi = max.floor();
        // No integers in range (incl. `5.2..=5.8`), or bounds outside the i64 integer domain
        // (a >2^63-wide integer range is meaningless for a spreadsheet) -> `#NUM!`.
        //
        // **Re-audit (Codex MEDIUM, 2026-06-20):** the upper guard MUST be `>=`, not `>`. `i64::MAX`
        // (2^63 - 1) is not f64-representable; `i64::MAX as f64` rounds UP to 2^63, so `hi == 2^63`
        // would slip past a `>` guard and then SATURATE through `as i64` to `i64::MAX` (a silent wrong
        // value). `lo` keeps `<` because `i64::MIN` (-2^63) IS exactly f64-representable, so
        // `lo == i64::MIN` is a valid in-domain bound that must be accepted.
        if !(lo.is_finite() && hi.is_finite())
            || lo > hi
            || lo < i64::MIN as f64
            || hi >= i64::MAX as f64
        {
            return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
        }
        Draw::Whole(lo as i64, hi as i64)
    } else {
        if min > max {
            return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
        }
        let span = max - min;
        // `1E308 - (-1E308)` overflows to `+inf`; a non-finite span can only yield non-finite cells.
        if !span.is_finite() {
            return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
        }
        Draw::Continuous(min, span)
    };

    let total = (rows as u64).saturating_mul(cols as u64);
    if total > (i32::MAX as u64) {
        return FunctionReturn::Scalar(Value::Error(ErrorValue::Num));
    }
    let total = total as usize;
    let mut out: Vec<Value> = Vec::with_capacity(total);

    match draw {
        Draw::Whole(lo_i, hi_i) => {
            for _ in 0..total {
                out.push(Value::Number(crate::volatile::next_rand_whole(lo_i, hi_i)));
            }
        }
        Draw::Continuous(min, span) => {
            for _ in 0..total {
                let v = min + crate::volatile::next_rand_unit() * span;
                // Defense-in-depth: even with a finite span, a pathological `min` + draw could land
                // a non-finite result; sanitize to `#NUM!` per the `Value::number` invariant (mirrors
                // SEQUENCE's per-element guard), never a raw NaN/Inf cell.
                if v.is_finite() {
                    out.push(Value::Number(v));
                } else {
                    out.push(Value::Error(ErrorValue::Num));
                }
            }
        }
    }

    let arr =
        ArrayValue::new(rows, cols, out).expect("rows*cols == total; ArrayValue::new succeeds");
    FunctionReturn::Array(arr)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> FunctionContext<'static> {
        // Static EvalContext stand-in for tests that don't need
        // workbook awareness. Volatile fns need a real ctx; SEQUENCE
        // doesn't.
        use std::sync::OnceLock;
        static ECTX: OnceLock<ql_types::EvalContext> = OnceLock::new();
        FunctionContext::new(ECTX.get_or_init(ql_types::EvalContext::default))
    }

    fn n(v: f64) -> FunctionArg {
        FunctionArg::Scalar(Value::Number(v))
    }

    fn expect_array(ret: FunctionReturn) -> ArrayValue {
        match ret {
            FunctionReturn::Array(a) => a,
            FunctionReturn::Scalar(v) => panic!("expected array, got Scalar({:?})", v),
        }
    }

    fn expect_scalar_error(ret: FunctionReturn) -> ErrorValue {
        match ret {
            FunctionReturn::Scalar(Value::Error(e)) => e,
            other => panic!("expected scalar error, got {:?}", other),
        }
    }

    #[test]
    fn sequence_rows_only_produces_column_vector() {
        let arr = expect_array(sequence(&[n(3.0)], &ctx()));
        assert_eq!(arr.rows(), 3);
        assert_eq!(arr.cols(), 1);
        assert_eq!(arr.at(0, 0), &Value::Number(1.0));
        assert_eq!(arr.at(1, 0), &Value::Number(2.0));
        assert_eq!(arr.at(2, 0), &Value::Number(3.0));
    }

    #[test]
    fn sequence_rows_cols_row_major_fill() {
        let arr = expect_array(sequence(&[n(2.0), n(3.0)], &ctx()));
        assert_eq!(arr.rows(), 2);
        assert_eq!(arr.cols(), 3);
        // Row-major: 1, 2, 3 across row 0; 4, 5, 6 across row 1.
        assert_eq!(arr.at(0, 0), &Value::Number(1.0));
        assert_eq!(arr.at(0, 1), &Value::Number(2.0));
        assert_eq!(arr.at(0, 2), &Value::Number(3.0));
        assert_eq!(arr.at(1, 0), &Value::Number(4.0));
        assert_eq!(arr.at(1, 1), &Value::Number(5.0));
        assert_eq!(arr.at(1, 2), &Value::Number(6.0));
    }

    #[test]
    fn sequence_custom_start() {
        let arr = expect_array(sequence(&[n(3.0), n(1.0), n(10.0)], &ctx()));
        assert_eq!(arr.at(0, 0), &Value::Number(10.0));
        assert_eq!(arr.at(1, 0), &Value::Number(11.0));
        assert_eq!(arr.at(2, 0), &Value::Number(12.0));
    }

    #[test]
    fn sequence_custom_start_and_step() {
        let arr = expect_array(sequence(&[n(4.0), n(1.0), n(10.0), n(5.0)], &ctx()));
        assert_eq!(arr.at(0, 0), &Value::Number(10.0));
        assert_eq!(arr.at(1, 0), &Value::Number(15.0));
        assert_eq!(arr.at(2, 0), &Value::Number(20.0));
        assert_eq!(arr.at(3, 0), &Value::Number(25.0));
    }

    #[test]
    fn sequence_negative_step() {
        let arr = expect_array(sequence(&[n(3.0), n(1.0), n(10.0), n(-1.0)], &ctx()));
        assert_eq!(arr.at(0, 0), &Value::Number(10.0));
        assert_eq!(arr.at(1, 0), &Value::Number(9.0));
        assert_eq!(arr.at(2, 0), &Value::Number(8.0));
    }

    #[test]
    fn sequence_truncates_fractional_dims() {
        // 2.7 truncates to 2; 3.999 truncates to 3.
        let arr = expect_array(sequence(&[n(2.7), n(3.999)], &ctx()));
        assert_eq!(arr.rows(), 2);
        assert_eq!(arr.cols(), 3);
    }

    /// **W5-108 (Phase 4.7.O) — Codex M2 closure**: SEQUENCE(0) must
    /// return scalar `#NUM!` per design § 13.1 ("if `rows < 1` →
    /// `#NUM!`"). Pre-fix returned a degenerate ArrayValue that the
    /// cell-boundary mapped to `#CALC!`, a spec drift from Excel
    /// canon (`SEQUENCE(0)` is `#NUM!` in Excel).
    #[test]
    fn sequence_zero_rows_returns_num_error() {
        let e = expect_scalar_error(sequence(&[n(0.0)], &ctx()));
        assert_eq!(e, ErrorValue::Num);
    }

    /// Symmetric: `cols < 1` (after `rows >= 1` passes) → `#NUM!`.
    #[test]
    fn sequence_zero_cols_returns_num_error() {
        let e = expect_scalar_error(sequence(&[n(3.0), n(0.0)], &ctx()));
        assert_eq!(e, ErrorValue::Num);
    }

    #[test]
    fn sequence_negative_rows_returns_value_error() {
        let e = expect_scalar_error(sequence(&[n(-1.0)], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    /// **Codex audit MEDIUM closure**: `SEQUENCE(-0.5)` must return
    /// `#VALUE!`, NOT a degenerate array (which surfaces as `#CALC!`).
    /// Pre-fix: `(-0.5).trunc()` is `-0.0` (sign-preserving f64),
    /// which passes `< 0.0` (since `-0.0 < 0.0` is false), then
    /// becomes `0` after `as u32` cast → degenerate ArrayValue →
    /// #CALC!. The fix moves the negativity check pre-trunc so
    /// fractional negatives are correctly rejected.
    #[test]
    fn sequence_negative_fractional_rows_returns_value_error_not_calc() {
        let e = expect_scalar_error(sequence(&[n(-0.5)], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    #[test]
    fn sequence_negative_fractional_cols_returns_value_error_not_calc() {
        let e = expect_scalar_error(sequence(&[n(1.0), n(-0.5)], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    #[test]
    fn sequence_zero_args_returns_na() {
        let e = expect_scalar_error(sequence(&[], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    #[test]
    fn sequence_five_args_returns_na() {
        let e = expect_scalar_error(sequence(&[n(1.0), n(1.0), n(1.0), n(1.0), n(1.0)], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    #[test]
    fn sequence_error_arg_propagates() {
        let div0 = FunctionArg::Scalar(Value::Error(ErrorValue::DivZero));
        let e = expect_scalar_error(sequence(&[div0], &ctx()));
        assert_eq!(
            e,
            ErrorValue::DivZero,
            "first-error-wins: SEQUENCE propagates the specific arg error"
        );
    }

    #[test]
    fn sequence_text_arg_that_parses_coerces_correctly() {
        let text_3 = FunctionArg::Scalar(Value::Text(std::sync::Arc::from("3")));
        let arr = expect_array(sequence(&[text_3], &ctx()));
        assert_eq!(arr.rows(), 3);
        assert_eq!(arr.cols(), 1);
    }

    #[test]
    fn sequence_text_arg_that_doesnt_parse_returns_value_error() {
        let bad = FunctionArg::Scalar(Value::Text(std::sync::Arc::from("not a number")));
        let e = expect_scalar_error(sequence(&[bad], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    #[test]
    fn sequence_range_arg_returns_value_error() {
        let r = FunctionArg::Range {
            values: vec![Value::Number(1.0)],
            rows: 1,
            cols: 1,
        };
        let e = expect_scalar_error(sequence(&[r], &ctx()));
        assert_eq!(
            e,
            ErrorValue::Value,
            "range arg at scalar position: #VALUE! per v1 (implicit intersection deferred)"
        );
    }

    // ===== W5-107 (Phase 4.7.N.1) — TRANSPOSE =====

    fn arr(rows: u32, cols: u32, cells: Vec<Value>) -> FunctionArg {
        FunctionArg::Array(ArrayValue::new(rows, cols, cells).unwrap())
    }

    /// TRANSPOSE of a 1×3 row → 3×1 column.
    #[test]
    fn transpose_1x3_to_3x1() {
        let input = arr(
            1,
            3,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)],
        );
        let result = expect_array(transpose(&[input], &ctx()));
        assert_eq!(result.rows(), 3);
        assert_eq!(result.cols(), 1);
        assert_eq!(result.at(0, 0), &Value::Number(1.0));
        assert_eq!(result.at(1, 0), &Value::Number(2.0));
        assert_eq!(result.at(2, 0), &Value::Number(3.0));
    }

    /// TRANSPOSE of a 3×1 column → 1×3 row.
    #[test]
    fn transpose_3x1_to_1x3() {
        let input = arr(
            3,
            1,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)],
        );
        let result = expect_array(transpose(&[input], &ctx()));
        assert_eq!(result.rows(), 1);
        assert_eq!(result.cols(), 3);
        assert_eq!(result.at(0, 0), &Value::Number(1.0));
        assert_eq!(result.at(0, 1), &Value::Number(2.0));
        assert_eq!(result.at(0, 2), &Value::Number(3.0));
    }

    /// TRANSPOSE of a 2×2 — rows ↔ cols swap.
    /// Input:  {1, 2; 3, 4} → output: {1, 3; 2, 4}.
    #[test]
    fn transpose_2x2_swaps_off_diagonal() {
        let input = arr(
            2,
            2,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
            ],
        );
        let result = expect_array(transpose(&[input], &ctx()));
        assert_eq!(result.rows(), 2);
        assert_eq!(result.cols(), 2);
        // Row 0: 1, 3.
        assert_eq!(result.at(0, 0), &Value::Number(1.0));
        assert_eq!(result.at(0, 1), &Value::Number(3.0));
        // Row 1: 2, 4.
        assert_eq!(result.at(1, 0), &Value::Number(2.0));
        assert_eq!(result.at(1, 1), &Value::Number(4.0));
    }

    /// TRANSPOSE of a non-square 2×3 → 3×2.
    /// Input:  {1, 2, 3; 4, 5, 6} → output: {1, 4; 2, 5; 3, 6}.
    #[test]
    fn transpose_2x3_to_3x2() {
        let input = arr(
            2,
            3,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
                Value::Number(6.0),
            ],
        );
        let result = expect_array(transpose(&[input], &ctx()));
        assert_eq!(result.rows(), 3);
        assert_eq!(result.cols(), 2);
        assert_eq!(result.at(0, 0), &Value::Number(1.0));
        assert_eq!(result.at(0, 1), &Value::Number(4.0));
        assert_eq!(result.at(1, 0), &Value::Number(2.0));
        assert_eq!(result.at(1, 1), &Value::Number(5.0));
        assert_eq!(result.at(2, 0), &Value::Number(3.0));
        assert_eq!(result.at(2, 1), &Value::Number(6.0));
    }

    /// TRANSPOSE of a Range arg — same shape semantics as Array arg.
    #[test]
    fn transpose_range_arg() {
        let input = FunctionArg::Range {
            values: vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
            ],
            rows: 2,
            cols: 2,
        };
        let result = expect_array(transpose(&[input], &ctx()));
        assert_eq!(result.rows(), 2);
        assert_eq!(result.cols(), 2);
        assert_eq!(result.at(0, 1), &Value::Number(3.0));
        assert_eq!(result.at(1, 0), &Value::Number(2.0));
    }

    /// TRANSPOSE of a scalar — implicit 1×1 array; result is 1×1
    /// containing the same value (Excel canon).
    #[test]
    fn transpose_scalar_returns_singleton() {
        let result = expect_array(transpose(&[n(42.0)], &ctx()));
        assert_eq!(result.rows(), 1);
        assert_eq!(result.cols(), 1);
        assert_eq!(result.at(0, 0), &Value::Number(42.0));
    }

    /// TRANSPOSE of a degenerate input (0 rows) → degenerate with
    /// swapped shape (0 cols).
    #[test]
    fn transpose_degenerate_input_returns_degenerate() {
        let input = FunctionArg::Array(ArrayValue::empty(0, 3));
        let result = expect_array(transpose(&[input], &ctx()));
        assert!(result.is_degenerate());
        assert_eq!(result.rows(), 3);
        assert_eq!(result.cols(), 0);
    }

    /// Error arg propagates per left-error-wins.
    #[test]
    fn transpose_error_arg_propagates() {
        let div0 = FunctionArg::Scalar(Value::Error(ErrorValue::DivZero));
        let e = expect_scalar_error(transpose(&[div0], &ctx()));
        assert_eq!(e, ErrorValue::DivZero);
    }

    /// Arity violations — 0 args → #N/A.
    #[test]
    fn transpose_zero_args_returns_na() {
        let e = expect_scalar_error(transpose(&[], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    /// Arity violations — 2 args → #N/A.
    #[test]
    fn transpose_two_args_returns_na() {
        let e = expect_scalar_error(transpose(&[n(1.0), n(2.0)], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    /// Idempotent: TRANSPOSE(TRANSPOSE(x)) == x (shape and values).
    #[test]
    fn transpose_is_involutive() {
        let input = arr(
            2,
            3,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
                Value::Number(5.0),
                Value::Number(6.0),
            ],
        );
        // Save original cells for comparison.
        let original_cells: Vec<Value> = match &input {
            FunctionArg::Array(a) => a.cells().to_vec(),
            _ => unreachable!(),
        };
        let once = expect_array(transpose(&[input], &ctx()));
        let twice = expect_array(transpose(&[FunctionArg::Array(once)], &ctx()));
        assert_eq!(twice.rows(), 2);
        assert_eq!(twice.cols(), 3);
        assert_eq!(twice.cells(), original_cells.as_slice());
    }

    // ===== W5-107 (Phase 4.7.N.2) — FILTER =====

    fn b(v: bool) -> Value {
        Value::Boolean(v)
    }

    /// FILTER row vector with mixed mask → row of kept values.
    /// {1,2,3,4} include {T,F,T,F} → {1,3} (1×2).
    #[test]
    fn filter_row_vector_keeps_truthy_only() {
        let array = arr(
            1,
            4,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
            ],
        );
        let include = arr(1, 4, vec![b(true), b(false), b(true), b(false)]);
        let result = expect_array(filter(&[array, include], &ctx()));
        assert_eq!(result.rows(), 1);
        assert_eq!(result.cols(), 2);
        assert_eq!(result.at(0, 0), &Value::Number(1.0));
        assert_eq!(result.at(0, 1), &Value::Number(3.0));
    }

    /// FILTER column vector with mixed mask → column of kept values.
    /// {1;2;3;4} include {T;F;T;F} → {1;3} (2×1).
    #[test]
    fn filter_column_vector_keeps_truthy_only() {
        let array = arr(
            4,
            1,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
            ],
        );
        let include = arr(4, 1, vec![b(true), b(false), b(true), b(false)]);
        let result = expect_array(filter(&[array, include], &ctx()));
        assert_eq!(result.rows(), 2);
        assert_eq!(result.cols(), 1);
        assert_eq!(result.at(0, 0), &Value::Number(1.0));
        assert_eq!(result.at(1, 0), &Value::Number(3.0));
    }

    /// FILTER with all-truthy mask preserves full input.
    #[test]
    fn filter_all_truthy_returns_full_input() {
        let array = arr(
            1,
            3,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)],
        );
        let include = arr(1, 3, vec![b(true), b(true), b(true)]);
        let result = expect_array(filter(&[array, include], &ctx()));
        assert_eq!(result.rows(), 1);
        assert_eq!(result.cols(), 3);
    }

    /// FILTER with all-false + no if_empty → degenerate ArrayValue.
    /// Cell-boundary writeback surfaces #CALC!.
    #[test]
    fn filter_all_false_no_if_empty_returns_degenerate() {
        let array = arr(
            1,
            3,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)],
        );
        let include = arr(1, 3, vec![b(false), b(false), b(false)]);
        let result = expect_array(filter(&[array, include], &ctx()));
        assert!(result.is_degenerate());
    }

    /// FILTER with all-false + if_empty → 1×1 of if_empty.
    #[test]
    fn filter_all_false_with_if_empty_returns_singleton() {
        let array = arr(
            1,
            3,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)],
        );
        let include = arr(1, 3, vec![b(false), b(false), b(false)]);
        let if_empty = FunctionArg::Scalar(Value::Text(std::sync::Arc::from("none")));
        let result = expect_array(filter(&[array, include, if_empty], &ctx()));
        assert_eq!(result.rows(), 1);
        assert_eq!(result.cols(), 1);
        assert_eq!(result.at(0, 0), &Value::Text(std::sync::Arc::from("none")));
    }

    /// Numeric truthy: non-zero number → keep; zero → drop.
    #[test]
    fn filter_numeric_truthy_zero_is_falsy() {
        let array = arr(
            1,
            4,
            vec![
                Value::Number(10.0),
                Value::Number(20.0),
                Value::Number(30.0),
                Value::Number(40.0),
            ],
        );
        let include = arr(
            1,
            4,
            vec![
                Value::Number(1.0),
                Value::Number(0.0),
                Value::Number(-1.0),
                Value::Number(0.0),
            ],
        );
        let result = expect_array(filter(&[array, include], &ctx()));
        assert_eq!(result.cols(), 2);
        assert_eq!(result.at(0, 0), &Value::Number(10.0));
        assert_eq!(result.at(0, 1), &Value::Number(30.0));
    }

    /// Blank in include → falsy.
    #[test]
    fn filter_blank_is_falsy() {
        let array = arr(1, 2, vec![Value::Number(1.0), Value::Number(2.0)]);
        let include = arr(1, 2, vec![Value::Blank, b(true)]);
        let result = expect_array(filter(&[array, include], &ctx()));
        assert_eq!(result.cols(), 1);
        assert_eq!(result.at(0, 0), &Value::Number(2.0));
    }

    /// Text in include → #VALUE! (v1 doesn't coerce text booleans).
    #[test]
    fn filter_text_in_include_returns_value_error() {
        let array = arr(1, 1, vec![Value::Number(1.0)]);
        let include = FunctionArg::Array(
            ArrayValue::new(1, 1, vec![Value::Text(std::sync::Arc::from("yes"))]).unwrap(),
        );
        let e = expect_scalar_error(filter(&[array, include], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    /// Error in include propagates immediately (left-error wins).
    #[test]
    fn filter_error_in_include_propagates() {
        let array = arr(1, 2, vec![Value::Number(1.0), Value::Number(2.0)]);
        let include = arr(1, 2, vec![b(true), Value::Error(ErrorValue::DivZero)]);
        let e = expect_scalar_error(filter(&[array, include], &ctx()));
        assert_eq!(e, ErrorValue::DivZero);
    }

    /// Shape mismatch — different lengths → #VALUE!.
    #[test]
    fn filter_length_mismatch_returns_value_error() {
        let array = arr(
            1,
            3,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)],
        );
        let include = arr(1, 2, vec![b(true), b(false)]);
        let e = expect_scalar_error(filter(&[array, include], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    /// Shape mismatch — different orientation (row array, column include).
    #[test]
    fn filter_orientation_mismatch_returns_value_error() {
        let array = arr(
            1,
            3,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)],
        );
        let include = arr(3, 1, vec![b(true), b(false), b(true)]);
        let e = expect_scalar_error(filter(&[array, include], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    /// 2D array (rows > 1 AND cols > 1) → #VALUE! (v1 1D only).
    #[test]
    fn filter_2d_array_returns_value_error() {
        let array = arr(
            2,
            2,
            vec![
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(4.0),
            ],
        );
        let include = arr(2, 2, vec![b(true), b(true), b(true), b(true)]);
        let e = expect_scalar_error(filter(&[array, include], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    /// Wrong arity — 0, 1, or 4+ args → #N/A.
    #[test]
    fn filter_zero_args_returns_na() {
        let e = expect_scalar_error(filter(&[], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    #[test]
    fn filter_one_arg_returns_na() {
        let array = arr(1, 1, vec![Value::Number(1.0)]);
        let e = expect_scalar_error(filter(&[array], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    #[test]
    fn filter_four_args_returns_na() {
        let array = arr(1, 1, vec![Value::Number(1.0)]);
        let include = arr(1, 1, vec![b(true)]);
        let if_empty = n(0.0);
        let extra = n(0.0);
        let e = expect_scalar_error(filter(&[array, include, if_empty, extra], &ctx()));
        assert_eq!(e, ErrorValue::NA);
    }

    /// Error in array arg propagates.
    #[test]
    fn filter_error_in_array_propagates() {
        let array = FunctionArg::Scalar(Value::Error(ErrorValue::Ref));
        let include = arr(1, 1, vec![b(true)]);
        let e = expect_scalar_error(filter(&[array, include], &ctx()));
        assert_eq!(e, ErrorValue::Ref);
    }

    /// W5-107-AUDIT Sonnet LOW closure: NaN in include surfaces #NUM!
    /// (IEEE NaN != 0.0 is true, which would have silently kept the
    /// corresponding row — must surface, not pass).
    #[test]
    fn filter_nan_in_include_returns_num_error() {
        let array = arr(1, 2, vec![Value::Number(10.0), Value::Number(20.0)]);
        let include = arr(1, 2, vec![Value::Number(f64::NAN), b(true)]);
        let e = expect_scalar_error(filter(&[array, include], &ctx()));
        assert_eq!(e, ErrorValue::Num);
    }

    /// **W5-108 (Phase 4.7.O) — Sonnet L4 closure**: FILTER with an
    /// error-valued `if_empty` arg lands the error as the singleton
    /// cell when all-false. Pre-4.7.O test surface didn't pin this;
    /// the function's documented behavior was implicit.
    #[test]
    fn filter_all_false_with_error_if_empty_returns_error_singleton() {
        let array = arr(1, 2, vec![Value::Number(1.0), Value::Number(2.0)]);
        let include = arr(1, 2, vec![b(false), b(false)]);
        let if_empty = FunctionArg::Scalar(Value::Error(ErrorValue::NA));
        let result = expect_array(filter(&[array, include, if_empty], &ctx()));
        // Singleton 1×1 with the error value at (0, 0).
        assert_eq!(result.rows(), 1);
        assert_eq!(result.cols(), 1);
        assert_eq!(result.at(0, 0), &Value::Error(ErrorValue::NA));
    }

    /// W5-107-AUDIT Sonnet LOW closure: if_empty as a degenerate
    /// ArrayValue (rows=0 or cols=0) must NOT panic on `.first()`;
    /// degenerate if_empty falls through to the degenerate-output
    /// path (cell-boundary surfaces #CALC!).
    #[test]
    fn filter_all_false_degenerate_if_empty_array_does_not_panic() {
        let array = arr(1, 2, vec![Value::Number(1.0), Value::Number(2.0)]);
        let include = arr(1, 2, vec![b(false), b(false)]);
        let if_empty = FunctionArg::Array(ArrayValue::empty(0, 1));
        let result = expect_array(filter(&[array, include, if_empty], &ctx()));
        // Degenerate output preserves input orientation (1 row).
        assert_eq!(result.rows(), 1);
        assert_eq!(result.cols(), 0);
    }

    // ===== Wave O (2026-06-20) — SORT / SORTBY / UNIQUE / RANDARRAY =====

    fn t(s: &str) -> Value {
        Value::Text(std::sync::Arc::from(s))
    }

    // ----- SORT -----

    /// SORT a 3×2 by the first column ascending; whole rows move together.
    #[test]
    fn sort_rows_ascending_by_first_col() {
        let input = arr(
            3,
            2,
            vec![
                Value::Number(3.0),
                t("c"),
                Value::Number(1.0),
                t("a"),
                Value::Number(2.0),
                t("b"),
            ],
        );
        let r = expect_array(sort(&[input], &ctx()));
        assert_eq!((r.rows(), r.cols()), (3, 2));
        assert_eq!(r.at(0, 0), &Value::Number(1.0));
        assert_eq!(r.at(0, 1), &t("a"));
        assert_eq!(r.at(1, 0), &Value::Number(2.0));
        assert_eq!(r.at(2, 0), &Value::Number(3.0));
    }

    /// SORT descending (`sort_order = -1`).
    #[test]
    fn sort_rows_descending() {
        let input = arr(
            3,
            1,
            vec![Value::Number(1.0), Value::Number(3.0), Value::Number(2.0)],
        );
        let r = expect_array(sort(&[input, n(1.0), n(-1.0)], &ctx()));
        assert_eq!(r.at(0, 0), &Value::Number(3.0));
        assert_eq!(r.at(1, 0), &Value::Number(2.0));
        assert_eq!(r.at(2, 0), &Value::Number(1.0));
    }

    /// SORT columns by a key row (`by_col = TRUE`).
    #[test]
    fn sort_by_col_reorders_columns() {
        // Row 0 is the key: {3, 1, 2}. Sorting columns ascending → {1,2,3}.
        let input = arr(
            2,
            3,
            vec![
                Value::Number(3.0),
                Value::Number(1.0),
                Value::Number(2.0),
                t("x"),
                t("y"),
                t("z"),
            ],
        );
        let r = expect_array(sort(
            &[input, n(1.0), n(1.0), FunctionArg::Scalar(b(true))],
            &ctx(),
        ));
        assert_eq!((r.rows(), r.cols()), (2, 3));
        // Key row sorted.
        assert_eq!(r.at(0, 0), &Value::Number(1.0));
        assert_eq!(r.at(0, 1), &Value::Number(2.0));
        assert_eq!(r.at(0, 2), &Value::Number(3.0));
        // Column 1 (orig key 1 → "y") moved to position 0 with its column.
        assert_eq!(r.at(1, 0), &t("y"));
        assert_eq!(r.at(1, 1), &t("z"));
        assert_eq!(r.at(1, 2), &t("x"));
    }

    /// Stability: equal keys keep their INPUT order (Excel 365 contract).
    #[test]
    fn sort_is_stable_on_ties() {
        let input = arr(
            3,
            2,
            vec![
                Value::Number(1.0),
                t("first"),
                Value::Number(1.0),
                t("second"),
                Value::Number(1.0),
                t("third"),
            ],
        );
        let r = expect_array(sort(&[input], &ctx()));
        assert_eq!(r.at(0, 1), &t("first"));
        assert_eq!(r.at(1, 1), &t("second"));
        assert_eq!(r.at(2, 1), &t("third"));
    }

    /// Cross-type precedence: Number < Text < Boolean (ascending).
    #[test]
    fn sort_type_precedence_number_text_bool() {
        let input = arr(3, 1, vec![Value::Boolean(true), t("b"), Value::Number(2.0)]);
        let r = expect_array(sort(&[input], &ctx()));
        assert_eq!(r.at(0, 0), &Value::Number(2.0));
        assert_eq!(r.at(1, 0), &t("b"));
        assert_eq!(r.at(2, 0), &Value::Boolean(true));
    }

    #[test]
    fn sort_index_out_of_range_is_value_error() {
        let input = arr(2, 1, vec![Value::Number(1.0), Value::Number(2.0)]);
        let e = expect_scalar_error(sort(&[input, n(5.0)], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    #[test]
    fn sort_bad_order_is_value_error() {
        let input = arr(2, 1, vec![Value::Number(1.0), Value::Number(2.0)]);
        let e = expect_scalar_error(sort(&[input, n(1.0), n(2.0)], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    #[test]
    fn sort_zero_args_is_na() {
        assert_eq!(expect_scalar_error(sort(&[], &ctx())), ErrorValue::NA);
    }

    // ----- SORTBY -----

    /// SORTBY reorders `array` rows by a parallel key vector.
    #[test]
    fn sortby_single_key_reorders_rows() {
        // array {a;b;c} by {3;1;2} ascending → {b;c;a}.
        let array = arr(3, 1, vec![t("a"), t("b"), t("c")]);
        let by = arr(
            3,
            1,
            vec![Value::Number(3.0), Value::Number(1.0), Value::Number(2.0)],
        );
        let r = expect_array(sortby(&[array, by], &ctx()));
        assert_eq!(r.at(0, 0), &t("b"));
        assert_eq!(r.at(1, 0), &t("c"));
        assert_eq!(r.at(2, 0), &t("a"));
    }

    /// SORTBY descending via an explicit order arg.
    #[test]
    fn sortby_descending_order() {
        let array = arr(3, 1, vec![t("a"), t("b"), t("c")]);
        let by = arr(
            3,
            1,
            vec![Value::Number(1.0), Value::Number(2.0), Value::Number(3.0)],
        );
        let r = expect_array(sortby(&[array, by, n(-1.0)], &ctx()));
        assert_eq!(r.at(0, 0), &t("c"));
        assert_eq!(r.at(2, 0), &t("a"));
    }

    /// SORTBY multi-key: primary ties broken by the secondary key.
    #[test]
    fn sortby_multi_key_tiebreak() {
        // array {a;b;c;d}; primary {1;1;2;2}; secondary {2;1;2;1}
        // → order by (primary asc, secondary asc): b(1,1), a(1,2), d(2,1), c(2,2).
        let array = arr(4, 1, vec![t("a"), t("b"), t("c"), t("d")]);
        let k1 = arr(
            4,
            1,
            vec![
                Value::Number(1.0),
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(2.0),
            ],
        );
        let k2 = arr(
            4,
            1,
            vec![
                Value::Number(2.0),
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(1.0),
            ],
        );
        let r = expect_array(sortby(&[array, k1, k2], &ctx()));
        assert_eq!(r.at(0, 0), &t("b"));
        assert_eq!(r.at(1, 0), &t("a"));
        assert_eq!(r.at(2, 0), &t("d"));
        assert_eq!(r.at(3, 0), &t("c"));
    }

    #[test]
    fn sortby_length_mismatch_is_value_error() {
        let array = arr(3, 1, vec![t("a"), t("b"), t("c")]);
        let by = arr(2, 1, vec![Value::Number(1.0), Value::Number(2.0)]);
        let e = expect_scalar_error(sortby(&[array, by], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    #[test]
    fn sortby_only_array_is_na() {
        let array = arr(2, 1, vec![t("a"), t("b")]);
        assert_eq!(
            expect_scalar_error(sortby(&[array], &ctx())),
            ErrorValue::NA
        );
    }

    /// Two consecutive order scalars (no by_array between) → #VALUE!.
    #[test]
    fn sortby_two_orders_in_a_row_is_value_error() {
        let array = arr(2, 1, vec![t("a"), t("b")]);
        let by = arr(2, 1, vec![Value::Number(1.0), Value::Number(2.0)]);
        let e = expect_scalar_error(sortby(&[array, by, n(1.0), n(-1.0)], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    // ----- UNIQUE -----

    /// UNIQUE distinct rows of a column vector, first-seen order.
    #[test]
    fn unique_column_distinct_first_seen() {
        let input = arr(
            5,
            1,
            vec![
                Value::Number(1.0),
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(3.0),
            ],
        );
        let r = expect_array(unique(&[input], &ctx()));
        assert_eq!((r.rows(), r.cols()), (3, 1));
        assert_eq!(r.at(0, 0), &Value::Number(1.0));
        assert_eq!(r.at(1, 0), &Value::Number(2.0));
        assert_eq!(r.at(2, 0), &Value::Number(3.0));
    }

    /// UNIQUE with `exactly_once` keeps only entries appearing exactly once.
    #[test]
    fn unique_exactly_once() {
        let input = arr(
            5,
            1,
            vec![
                Value::Number(1.0),
                Value::Number(1.0),
                Value::Number(2.0),
                Value::Number(3.0),
                Value::Number(3.0),
            ],
        );
        let r = expect_array(unique(
            &[
                input,
                FunctionArg::Scalar(b(false)),
                FunctionArg::Scalar(b(true)),
            ],
            &ctx(),
        ));
        assert_eq!((r.rows(), r.cols()), (1, 1));
        assert_eq!(r.at(0, 0), &Value::Number(2.0));
    }

    /// UNIQUE on whole rows of a 2D array (dedup matching rows).
    #[test]
    fn unique_2d_rows() {
        // Rows: (1,a), (1,a), (2,b) → distinct (1,a),(2,b).
        let input = arr(
            3,
            2,
            vec![
                Value::Number(1.0),
                t("a"),
                Value::Number(1.0),
                t("a"),
                Value::Number(2.0),
                t("b"),
            ],
        );
        let r = expect_array(unique(&[input], &ctx()));
        assert_eq!((r.rows(), r.cols()), (2, 2));
        assert_eq!(r.at(0, 0), &Value::Number(1.0));
        assert_eq!(r.at(0, 1), &t("a"));
        assert_eq!(r.at(1, 0), &Value::Number(2.0));
        assert_eq!(r.at(1, 1), &t("b"));
    }

    /// UNIQUE over columns (`by_col = TRUE`).
    #[test]
    fn unique_by_col() {
        // Columns: {1,1,2} across one row → distinct columns {1,2}.
        let input = arr(
            1,
            3,
            vec![Value::Number(1.0), Value::Number(1.0), Value::Number(2.0)],
        );
        let r = expect_array(unique(&[input, FunctionArg::Scalar(b(true))], &ctx()));
        assert_eq!((r.rows(), r.cols()), (1, 2));
        assert_eq!(r.at(0, 0), &Value::Number(1.0));
        assert_eq!(r.at(0, 1), &Value::Number(2.0));
    }

    /// Text dedup is case-insensitive (matches sort_cmp's fold).
    #[test]
    fn unique_text_case_insensitive() {
        let input = arr(2, 1, vec![t("Hello"), t("hello")]);
        let r = expect_array(unique(&[input], &ctx()));
        assert_eq!((r.rows(), r.cols()), (1, 1));
        assert_eq!(r.at(0, 0), &t("Hello"), "first-seen casing is kept");
    }

    /// Cross-type entries are distinct: 0 and FALSE do NOT dedup.
    #[test]
    fn unique_cross_type_distinct() {
        let input = arr(2, 1, vec![Value::Number(0.0), Value::Boolean(false)]);
        let r = expect_array(unique(&[input], &ctx()));
        assert_eq!(r.rows(), 2);
    }

    /// `exactly_once` with all entries duplicated → degenerate (#CALC!).
    #[test]
    fn unique_exactly_once_all_dup_is_degenerate() {
        let input = arr(2, 1, vec![Value::Number(1.0), Value::Number(1.0)]);
        let r = expect_array(unique(
            &[
                input,
                FunctionArg::Scalar(b(false)),
                FunctionArg::Scalar(b(true)),
            ],
            &ctx(),
        ));
        assert!(r.is_degenerate());
    }

    #[test]
    fn unique_zero_args_is_na() {
        assert_eq!(expect_scalar_error(unique(&[], &ctx())), ErrorValue::NA);
    }

    // ----- RANDARRAY -----

    #[test]
    fn randarray_default_is_1x1_unit_interval() {
        let r = expect_array(randarray(&[], &ctx()));
        assert_eq!((r.rows(), r.cols()), (1, 1));
        if let Value::Number(v) = r.at(0, 0) {
            assert!((0.0..1.0).contains(v), "default RANDARRAY in [0,1): {v}");
        } else {
            panic!("expected a number");
        }
    }

    #[test]
    fn randarray_shape_from_rows_cols() {
        let r = expect_array(randarray(&[n(2.0), n(3.0)], &ctx()));
        assert_eq!((r.rows(), r.cols()), (2, 3));
    }

    /// Seeding the shared RNG makes RANDARRAY reproducible.
    #[test]
    fn randarray_is_deterministic_under_seed() {
        crate::volatile::set_test_rng_seed(0xA11CE_u64);
        let a = expect_array(randarray(&[n(2.0), n(2.0)], &ctx()));
        crate::volatile::set_test_rng_seed(0xA11CE_u64);
        let b = expect_array(randarray(&[n(2.0), n(2.0)], &ctx()));
        assert_eq!(a.cells(), b.cells(), "same seed → same RANDARRAY");
        crate::volatile::clear_test_overrides();
    }

    #[test]
    fn randarray_continuous_bounds_respected() {
        crate::volatile::set_test_rng_seed(0xBEEF_u64);
        let r = expect_array(randarray(&[n(4.0), n(4.0), n(5.0), n(10.0)], &ctx()));
        for v in r.cells() {
            if let Value::Number(x) = v {
                assert!(
                    (5.0..10.0).contains(x),
                    "continuous value out of [5,10): {x}"
                );
            } else {
                panic!("expected number");
            }
        }
        crate::volatile::clear_test_overrides();
    }

    #[test]
    fn randarray_whole_number_integers_in_range() {
        crate::volatile::set_test_rng_seed(0xF00D_u64);
        let r = expect_array(randarray(
            &[n(3.0), n(3.0), n(1.0), n(6.0), FunctionArg::Scalar(b(true))],
            &ctx(),
        ));
        for v in r.cells() {
            if let Value::Number(x) = v {
                assert_eq!(x.fract(), 0.0, "whole-number must be integral: {x}");
                assert!((1.0..=6.0).contains(x), "integer out of [1,6]: {x}");
            } else {
                panic!("expected number");
            }
        }
        crate::volatile::clear_test_overrides();
    }

    #[test]
    fn randarray_min_gt_max_is_num_error() {
        let e = expect_scalar_error(randarray(&[n(1.0), n(1.0), n(10.0), n(5.0)], &ctx()));
        assert_eq!(e, ErrorValue::Num);
    }

    #[test]
    fn randarray_zero_rows_is_num_error() {
        let e = expect_scalar_error(randarray(&[n(0.0)], &ctx()));
        assert_eq!(e, ErrorValue::Num);
    }

    #[test]
    fn randarray_negative_rows_is_value_error() {
        let e = expect_scalar_error(randarray(&[n(-1.0)], &ctx()));
        assert_eq!(e, ErrorValue::Value);
    }

    #[test]
    fn randarray_too_many_args_is_na() {
        let e = expect_scalar_error(randarray(
            &[
                n(1.0),
                n(1.0),
                n(0.0),
                n(1.0),
                FunctionArg::Scalar(b(false)),
                n(9.0),
            ],
            &ctx(),
        ));
        assert_eq!(e, ErrorValue::NA);
    }

    /// **Megaudit (2026-06-20) — Codex/Opus HIGH:** wide whole-number bounds must NOT panic on i64
    /// span overflow; they surface `#NUM!` (a >2^63-wide integer range is meaningless).
    #[test]
    fn randarray_whole_number_wide_bounds_is_num_not_panic() {
        let e = expect_scalar_error(randarray(
            &[
                n(1.0),
                n(1.0),
                n(-1.0e20),
                n(1.0e20),
                FunctionArg::Scalar(b(true)),
            ],
            &ctx(),
        ));
        assert_eq!(e, ErrorValue::Num);
    }

    /// **Megaudit — Codex HIGH:** `min > max` with a huge row count must error FAST (before the
    /// ~2.1B-cell allocation), i.e. the bound check precedes `Vec::with_capacity`.
    #[test]
    fn randarray_min_gt_max_errors_before_allocating() {
        let e = expect_scalar_error(randarray(
            &[n(2_147_483_647.0), n(1.0), n(10.0), n(5.0)],
            &ctx(),
        ));
        assert_eq!(e, ErrorValue::Num);
    }

    /// **Re-audit — Codex MEDIUM:** the whole-number upper bound `2^63` (== `i64::MAX as f64`, which
    /// rounds up) must be rejected as `#NUM!`, NOT saturated through `as i64` to a finite value.
    #[test]
    fn randarray_whole_number_at_i64_max_boundary_is_num() {
        let two_pow_63 = 9_223_372_036_854_775_808.0_f64; // == i64::MAX as f64 (the rounded boundary)
        let e = expect_scalar_error(randarray(
            &[
                n(1.0),
                n(1.0),
                n(two_pow_63),
                n(two_pow_63),
                FunctionArg::Scalar(b(true)),
            ],
            &ctx(),
        ));
        assert_eq!(e, ErrorValue::Num);
    }

    /// **Megaudit — Codex MEDIUM:** a non-finite continuous span (`1e308 - -1e308 = inf`) must
    /// surface `#NUM!`, never raw `Inf`/`NaN` cells.
    #[test]
    fn randarray_continuous_nonfinite_span_is_num() {
        let e = expect_scalar_error(randarray(
            &[n(1.0), n(1.0), n(-1.0e308), n(1.0e308)],
            &ctx(),
        ));
        assert_eq!(e, ErrorValue::Num);
    }

    /// **Megaudit — Codex/Opus/Sonnet MEDIUM:** `sort_cmp` stays a strict-weak-ordering even if a
    /// raw `NaN` reaches it (defense-in-depth) — SORT must not panic / loop, and NaN sorts after
    /// every real number.
    #[test]
    fn sort_with_raw_nan_is_total_order_no_panic() {
        let input = arr(
            3,
            1,
            vec![
                Value::Number(f64::NAN),
                Value::Number(2.0),
                Value::Number(1.0),
            ],
        );
        let r = expect_array(sort(&[input], &ctx()));
        assert_eq!((r.rows(), r.cols()), (3, 1));
        // Reals ascend; NaN lands last (deterministic placement).
        assert_eq!(r.at(0, 0), &Value::Number(1.0));
        assert_eq!(r.at(1, 0), &Value::Number(2.0));
        assert!(matches!(r.at(2, 0), Value::Number(n) if n.is_nan()));
    }

    /// **Megaudit — Sonnet HIGH (REJECTED as a bug, pinned as a contract):** Excel reverses the
    /// type-tier order in DESCENDING sort except blanks — so errors sort FIRST descending. This
    /// pins the (verified-correct) behavior so a future "fix" toward errors-last can't regress it.
    #[test]
    fn sort_descending_places_errors_first_excel_canon() {
        use ql_types::ErrorValue as EV;
        let input = arr(
            3,
            1,
            vec![
                Value::Number(1.0),
                Value::Error(EV::DivZero),
                Value::Number(3.0),
            ],
        );
        let r = expect_array(sort(&[input, n(1.0), n(-1.0)], &ctx()));
        // Descending: error first (tier reversed), then 3, then 1.
        assert!(matches!(r.at(0, 0), Value::Error(_)));
        assert_eq!(r.at(1, 0), &Value::Number(3.0));
        assert_eq!(r.at(2, 0), &Value::Number(1.0));
    }
}
