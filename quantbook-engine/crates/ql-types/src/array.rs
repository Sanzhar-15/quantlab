//! `ArrayValue` — a 2D array of `Value` cells.
//!
//! **Phase 4.7 sub-phase A (W5-95)** — first sub-phase of the array-formulas
//! and dynamic-spills arc. Design doc:
//! `docs/architecture/2026-05-14-array-formulas-and-spills.md` § 6.1.
//!
//! ## Why `ql-types` and not `ql-exec`?
//!
//! Codex design review (HIGH-1): the function-dispatch ABI in `ql-functions`
//! must be able to PASS and RETURN array values. `ql-functions` depends only
//! on `ql-types` — adding a `ql-functions` → `ql-exec` edge would close a
//! cycle (since `ql-exec` already depends on `ql-functions`). So `ArrayValue`
//! lives here, alongside `Value` and `ErrorValue`.
//!
//! ## What this is NOT
//!
//! - `ArrayValue` is NOT a `Value` variant. Storage cells stay scalar by
//!   Excel canon — spilling MATERIALIZES arrays into per-cell scalars in
//!   the computed overlay. `Value::Array(...)` would force every `read`
//!   caller to handle the multi-cell case, which is wrong at that boundary.
//! - `ArrayValue` is NOT an iterator-over-`Value`. It is a fixed-shape
//!   container with row-major indexing.
//!
//! ## Invariants
//!
//! 1. **Length:** `cells.len() == (rows as usize) * (cols as usize)`. The
//!    `new` constructor enforces this; convenience constructors `row`,
//!    `column`, `singleton`, and `empty` build correct shapes by
//!    construction.
//! 2. **Row-major:** `cells[row * cols + col]` is the cell at logical
//!    coordinate `(row, col)`. Iteration order in `cells.iter()` is
//!    row-major.
//! 3. **Degenerate shapes:** `rows == 0 || cols == 0` produces `cells: []`.
//!    Degenerate arrays are valid containers (functions like `FILTER` with
//!    an all-false mask produce them); the runtime spill path surfaces them
//!    as `#CALC!` (NOT `#SPILL!`) per design § 9.1.
//!
//! ## Equality
//!
//! `PartialEq` only — `Value::Number(f64)` is not `Eq` (NaN). Test code
//! that compares `ArrayValue`s composed of NaN should use bitwise
//! comparison helpers, not `==`.

use std::fmt;

use crate::value::Value;

/// A 2D array of `Value` cells in row-major layout.
///
/// Used at the EVAL boundary and in the unified function-dispatch ABI
/// (`FunctionArg::Array` / `FunctionReturn::Array`, defined in
/// `ql-functions`). Storage cells stay scalar — see module docs.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ArrayValue {
    rows: u32,
    cols: u32,
    cells: Vec<Value>,
}

/// Errors emitted when constructing or operating on an `ArrayValue` with
/// invalid arguments. These are PROGRAMMING errors (caller-side bugs);
/// user-visible array errors (degenerate result, out-of-bounds spill, etc.)
/// surface as `Value::Error(ErrorValue::*)` at the eval boundary, not here.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ArrayShapeError {
    /// Number of cells supplied doesn't match `rows * cols`.
    CellCountMismatch {
        rows: u32,
        cols: u32,
        expected: usize,
        found: usize,
    },

    /// Coordinate passed to `at` / `at_mut` is outside the array bounds.
    IndexOutOfBounds {
        row: u32,
        col: u32,
        rows: u32,
        cols: u32,
    },
}

impl fmt::Display for ArrayShapeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CellCountMismatch {
                rows,
                cols,
                expected,
                found,
            } => write!(
                f,
                "ArrayValue construction: cell count {found} does not match \
                 rows ({rows}) * cols ({cols}) = {expected}"
            ),
            Self::IndexOutOfBounds {
                row,
                col,
                rows,
                cols,
            } => write!(
                f,
                "ArrayValue index out of bounds: ({row}, {col}) for shape ({rows}, {cols})"
            ),
        }
    }
}

impl std::error::Error for ArrayShapeError {}

impl ArrayValue {
    /// Construct an array from `rows × cols` cells in row-major order.
    ///
    /// Returns `Err(CellCountMismatch)` if `cells.len() != rows * cols`.
    /// For degenerate shapes (`rows == 0` or `cols == 0`), `cells` must
    /// be empty.
    pub fn new(rows: u32, cols: u32, cells: Vec<Value>) -> Result<Self, ArrayShapeError> {
        let expected = (rows as usize).checked_mul(cols as usize).ok_or(
            ArrayShapeError::CellCountMismatch {
                rows,
                cols,
                expected: usize::MAX,
                found: cells.len(),
            },
        )?;
        if cells.len() != expected {
            return Err(ArrayShapeError::CellCountMismatch {
                rows,
                cols,
                expected,
                found: cells.len(),
            });
        }
        Ok(Self { rows, cols, cells })
    }

    /// 1×1 array wrapping a single value. Used by `FILTER`'s `if_empty`
    /// path (a scalar fallback returned in array form).
    pub fn singleton(value: Value) -> Self {
        Self {
            rows: 1,
            cols: 1,
            cells: vec![value],
        }
    }

    /// 1×N horizontal vector. Convenience constructor.
    pub fn row(values: Vec<Value>) -> Self {
        let cols = values.len() as u32;
        Self {
            rows: 1,
            cols,
            cells: values,
        }
    }

    /// N×1 vertical vector. Convenience constructor.
    pub fn column(values: Vec<Value>) -> Self {
        let rows = values.len() as u32;
        Self {
            rows,
            cols: 1,
            cells: values,
        }
    }

    /// Degenerate (zero-area) array: `rows == 0 || cols == 0`, `cells` empty.
    /// Returned by `FILTER` when no `include` cell is TRUE and no `if_empty`
    /// is provided (the function itself then returns `#CALC!` instead of
    /// this — see design § 9.1).
    pub fn empty(rows: u32, cols: u32) -> Self {
        debug_assert!(
            rows == 0 || cols == 0,
            "ArrayValue::empty: ({rows}, {cols}) is not degenerate"
        );
        Self {
            rows,
            cols,
            cells: Vec::new(),
        }
    }

    /// Number of rows. `u32` for symmetry with `RowId`.
    #[inline]
    pub fn rows(&self) -> u32 {
        self.rows
    }

    /// Number of columns.
    #[inline]
    pub fn cols(&self) -> u32 {
        self.cols
    }

    /// Total cell count (`rows * cols`). 0 if degenerate.
    #[inline]
    pub fn len(&self) -> usize {
        self.cells.len()
    }

    /// True if `rows == 0` or `cols == 0`. Distinguished from `len() == 0`
    /// only for clarity; the two are equivalent given the construction
    /// invariant.
    #[inline]
    pub fn is_degenerate(&self) -> bool {
        self.rows == 0 || self.cols == 0
    }

    /// True if degenerate OR `len() == 0`. Provided for the `Vec`-like
    /// API symmetry; identical to `is_degenerate()` under the invariant.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// Borrow the cell at logical `(row, col)`. Returns `None` for
    /// out-of-bounds. Use [`at`](Self::at) for the panicking variant.
    #[inline]
    pub fn get(&self, row: u32, col: u32) -> Option<&Value> {
        if row >= self.rows || col >= self.cols {
            return None;
        }
        Some(&self.cells[(row as usize) * (self.cols as usize) + (col as usize)])
    }

    /// Borrow the cell at logical `(row, col)`. Panics on out-of-bounds —
    /// for the fallible variant use [`get`](Self::get).
    #[inline]
    pub fn at(&self, row: u32, col: u32) -> &Value {
        self.get(row, col).unwrap_or_else(|| {
            panic!(
                "ArrayValue::at: ({row}, {col}) out of bounds for shape ({}, {})",
                self.rows, self.cols
            )
        })
    }

    /// First cell — `cells[0]`. Panics if degenerate. Helper for callers
    /// (e.g. tests) that need a single-cell view; the runtime's array →
    /// scalar contract uses `#CALC!`, NOT `first()` (per design § 6.3).
    pub fn first(&self) -> &Value {
        self.cells
            .first()
            .expect("ArrayValue::first: degenerate array has no cells")
    }

    /// Borrow the underlying row-major `Vec<Value>`. Useful for fast
    /// iteration in evaluator hot paths.
    #[inline]
    pub fn cells(&self) -> &[Value] {
        &self.cells
    }

    /// Iterate cells in row-major order.
    pub fn iter(&self) -> std::slice::Iter<'_, Value> {
        self.cells.iter()
    }

    /// Iterate rows as `&[Value]` slices. The slice length is always
    /// `cols`. Skips iteration entirely if `is_degenerate()`.
    pub fn iter_rows(&self) -> impl Iterator<Item = &[Value]> + '_ {
        let cols = self.cols as usize;
        self.cells
            .chunks_exact(cols.max(1))
            .take(self.rows as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorValue;

    fn n(x: f64) -> Value {
        Value::Number(x)
    }

    #[test]
    fn singleton_is_1x1() {
        let a = ArrayValue::singleton(n(42.0));
        assert_eq!(a.rows(), 1);
        assert_eq!(a.cols(), 1);
        assert_eq!(a.len(), 1);
        assert!(!a.is_degenerate());
        assert!(matches!(a.first(), Value::Number(x) if *x == 42.0));
    }

    #[test]
    fn row_constructor_is_1xn() {
        let a = ArrayValue::row(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(a.rows(), 1);
        assert_eq!(a.cols(), 3);
        assert_eq!(a.len(), 3);
        assert!(matches!(a.at(0, 1), Value::Number(x) if *x == 2.0));
    }

    #[test]
    fn column_constructor_is_nx1() {
        let a = ArrayValue::column(vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(a.rows(), 3);
        assert_eq!(a.cols(), 1);
        assert_eq!(a.len(), 3);
        assert!(matches!(a.at(1, 0), Value::Number(x) if *x == 2.0));
    }

    #[test]
    fn new_validates_cell_count() {
        // Wrong count — error.
        let err = ArrayValue::new(2, 3, vec![n(1.0); 5]).unwrap_err();
        assert!(matches!(
            err,
            ArrayShapeError::CellCountMismatch {
                rows: 2,
                cols: 3,
                expected: 6,
                found: 5
            }
        ));
        // Right count — ok.
        let a = ArrayValue::new(2, 3, vec![n(1.0); 6]).unwrap();
        assert_eq!(a.rows(), 2);
        assert_eq!(a.cols(), 3);
        assert_eq!(a.len(), 6);
    }

    #[test]
    fn new_with_degenerate_shape_requires_empty_cells() {
        // 0×N or N×0 with empty cells — ok.
        let a = ArrayValue::new(0, 5, vec![]).unwrap();
        assert!(a.is_degenerate());
        assert!(a.is_empty());
        let b = ArrayValue::new(5, 0, vec![]).unwrap();
        assert!(b.is_degenerate());
        // 0×N with cells — error.
        let err = ArrayValue::new(0, 5, vec![n(1.0)]).unwrap_err();
        assert!(matches!(err, ArrayShapeError::CellCountMismatch { .. }));
    }

    #[test]
    fn empty_helper_constructs_degenerate() {
        let a = ArrayValue::empty(0, 3);
        assert!(a.is_degenerate());
        assert_eq!(a.rows(), 0);
        assert_eq!(a.cols(), 3);
        assert_eq!(a.len(), 0);
    }

    #[test]
    fn row_major_indexing() {
        // 2×3 row-major: [1, 2, 3, 4, 5, 6]
        //                 [[1, 2, 3], [4, 5, 6]]
        let a =
            ArrayValue::new(2, 3, vec![n(1.0), n(2.0), n(3.0), n(4.0), n(5.0), n(6.0)]).unwrap();
        assert!(matches!(a.at(0, 0), Value::Number(x) if *x == 1.0));
        assert!(matches!(a.at(0, 1), Value::Number(x) if *x == 2.0));
        assert!(matches!(a.at(0, 2), Value::Number(x) if *x == 3.0));
        assert!(matches!(a.at(1, 0), Value::Number(x) if *x == 4.0));
        assert!(matches!(a.at(1, 1), Value::Number(x) if *x == 5.0));
        assert!(matches!(a.at(1, 2), Value::Number(x) if *x == 6.0));
    }

    #[test]
    fn get_returns_none_for_out_of_bounds() {
        let a = ArrayValue::row(vec![n(1.0), n(2.0)]);
        assert!(a.get(0, 0).is_some());
        assert!(a.get(0, 2).is_none());
        assert!(a.get(1, 0).is_none());
        assert!(a.get(u32::MAX, u32::MAX).is_none());
    }

    #[test]
    #[should_panic(expected = "out of bounds")]
    fn at_panics_on_out_of_bounds() {
        let a = ArrayValue::row(vec![n(1.0)]);
        let _ = a.at(0, 7);
    }

    #[test]
    #[should_panic(expected = "degenerate array has no cells")]
    fn first_panics_on_degenerate() {
        let a = ArrayValue::empty(0, 3);
        let _ = a.first();
    }

    #[test]
    fn iter_rows_yields_row_slices() {
        // 2×3 array; iter_rows should yield two slices of len 3 each.
        let a =
            ArrayValue::new(2, 3, vec![n(1.0), n(2.0), n(3.0), n(4.0), n(5.0), n(6.0)]).unwrap();
        let rows: Vec<&[Value]> = a.iter_rows().collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].len(), 3);
        assert_eq!(rows[1].len(), 3);
        assert!(matches!(rows[0][2], Value::Number(x) if x == 3.0));
        assert!(matches!(rows[1][0], Value::Number(x) if x == 4.0));
    }

    #[test]
    fn iter_yields_row_major() {
        let a = ArrayValue::new(2, 2, vec![n(10.0), n(20.0), n(30.0), n(40.0)]).unwrap();
        let vs: Vec<f64> = a
            .iter()
            .map(|v| match v {
                Value::Number(x) => *x,
                _ => panic!("not a number"),
            })
            .collect();
        assert_eq!(vs, vec![10.0, 20.0, 30.0, 40.0]);
    }

    #[test]
    fn heterogeneous_cells_compile() {
        // Array cells can be mixed type. Excel canon: error literals can
        // appear in array constants. Verify the type accepts the union.
        let a = ArrayValue::row(vec![
            Value::Number(1.5),
            Value::Boolean(true),
            Value::text("hi"),
            Value::Error(ErrorValue::Num),
        ]);
        assert_eq!(a.len(), 4);
        assert!(matches!(a.at(0, 3), Value::Error(ErrorValue::Num)));
    }

    #[test]
    fn default_is_degenerate_zero_zero() {
        let a = ArrayValue::default();
        assert_eq!(a.rows(), 0);
        assert_eq!(a.cols(), 0);
        assert!(a.is_degenerate());
        assert!(a.is_empty());
    }

    #[test]
    fn equality_compares_shape_and_cells() {
        let a = ArrayValue::row(vec![n(1.0), n(2.0)]);
        let b = ArrayValue::row(vec![n(1.0), n(2.0)]);
        let c = ArrayValue::column(vec![n(1.0), n(2.0)]); // same cells, different shape
        let d = ArrayValue::row(vec![n(1.0), n(3.0)]); // different cells
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
    }
}
