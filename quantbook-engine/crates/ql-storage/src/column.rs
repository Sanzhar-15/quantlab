//! `ColumnStore` — chunked Arrow base + per-chunk sparse overlay.
//!
//! Per spec Part V §4 Week 2 Days 3-4:
//! - Each column is `Vec<Arc<dyn arrow_array::Array>>` (one chunk per `chunk_rows` rows).
//! - Each chunk has a parallel `SparseOverlay` for cell edits.
//! - Default chunk size: 16,384 rows. Override via `QBOOK_CHUNK_ROWS` env var read once at
//!   construction time. (Constant per ColumnStore — switching mid-life isn't supported.)
//! - Read merge: overlay-first, base-fallback. Out-of-bounds reads return `Value::Blank`.
//! - Chunk-replace, not cell-mutate: `replace_chunk(idx, new_array)` swaps a whole chunk's
//!   base and clears its overlay. Used by recompute. Cell-level writes go through `put`.
//! - Phase 0 base type: Float64Array. Boolean/Text base chunks come in Week 4+; for now the
//!   `read_base` helper just handles the Float64 case and `Value::Blank` otherwise.

use std::sync::Arc;

use arrow_array::{Array, ArrayRef, Float64Array};
use ql_types::{RowId, Value, MAX_ROW};

use crate::overlay::SparseOverlay;

/// Default chunk size in rows. Override via `QBOOK_CHUNK_ROWS` env var.
pub const DEFAULT_CHUNK_ROWS: u32 = 16_384;

/// Resolve a chunk-rows value from an optional env-var string.
///
/// `None` (var unset) → `DEFAULT_CHUNK_ROWS`.
/// `Some(non-u32)` → panic with a clear message.
/// `Some("0")` → panic (zero chunks are nonsense).
/// `Some(valid)` → that u32.
///
/// Per codex r13 N8: prior behavior silently defaulted on any parse failure, which would let
/// a misconfigured A7 chunk-size sweep benchmark the wrong chunk size while pretending to
/// test another. This is the pure-function form; `chunk_rows_from_env()` is a thin wrapper
/// that reads `QBOOK_CHUNK_ROWS` and calls this.
pub fn resolve_chunk_rows(env_value: Option<&str>) -> u32 {
    match env_value {
        None => DEFAULT_CHUNK_ROWS,
        Some(s) => {
            let n: u32 = s.parse().unwrap_or_else(|_| {
                panic!(
                    "QBOOK_CHUNK_ROWS is set to {s:?} which is not a u32; \
                     fix the env var or unset to use default {DEFAULT_CHUNK_ROWS}"
                )
            });
            assert!(
                n > 0,
                "QBOOK_CHUNK_ROWS must be > 0 (got {n}); fix the env var or unset"
            );
            n
        }
    }
}

/// Read `QBOOK_CHUNK_ROWS` from env. Thin wrapper around [`resolve_chunk_rows`].
pub fn chunk_rows_from_env() -> u32 {
    resolve_chunk_rows(std::env::var("QBOOK_CHUNK_ROWS").ok().as_deref())
}

/// Chunked column with overlay. Invariants:
/// - `base_chunks.len() == overlays.len()`.
/// - Every chunk except possibly the last is exactly `chunk_rows` long.
/// - Last chunk MAY be shorter (open-ended column; rows beyond it read as `Blank`).
#[derive(Clone, Debug)]
pub struct ColumnStore {
    chunk_rows: u32,
    base_chunks: Vec<ArrayRef>,
    overlays: Vec<SparseOverlay>,
}

impl ColumnStore {
    /// New empty column. Chunk size taken from `QBOOK_CHUNK_ROWS` env, default 16384.
    pub fn new() -> Self {
        Self::with_chunk_rows(chunk_rows_from_env())
    }

    /// New empty column with an explicit chunk size. Tests use this to exercise boundaries
    /// with small chunks.
    pub fn with_chunk_rows(chunk_rows: u32) -> Self {
        assert!(chunk_rows > 0, "chunk_rows must be > 0");
        Self {
            chunk_rows,
            base_chunks: Vec::new(),
            overlays: Vec::new(),
        }
    }

    /// Construct from a vector of base chunks (typically the import path).
    ///
    /// Enforces invariants (per codex r13 N2):
    /// - `chunk_rows > 0`
    /// - Every non-last chunk is exactly `chunk_rows` long.
    /// - The last chunk may be shorter but must not exceed `chunk_rows`.
    /// - Every chunk must be `Float64Array` (Phase 0 limit — see `read_base` doc).
    ///
    /// Panics on violation. Prior behavior accepted invalid layouts and silently misrouted
    /// reads via `locate()`.
    pub fn from_chunks(chunk_rows: u32, base_chunks: Vec<ArrayRef>) -> Self {
        assert!(chunk_rows > 0, "chunk_rows must be > 0");
        let last_idx = base_chunks.len().saturating_sub(1);
        for (idx, arr) in base_chunks.iter().enumerate() {
            let len = arr.len();
            assert!(
                arr.as_any().downcast_ref::<Float64Array>().is_some(),
                "ColumnStore::from_chunks: chunk {idx} has type {:?}; Phase 0 requires Float64Array",
                arr.data_type()
            );
            if idx < last_idx {
                assert!(
                    len == chunk_rows as usize,
                    "ColumnStore::from_chunks: non-last chunk {idx} has len {len}, expected exactly {chunk_rows}"
                );
            } else {
                assert!(
                    len <= chunk_rows as usize,
                    "ColumnStore::from_chunks: last chunk {idx} has len {len}, exceeds chunk_rows {chunk_rows}"
                );
            }
        }
        let overlays = base_chunks.iter().map(|_| SparseOverlay::new()).collect();
        Self {
            chunk_rows,
            base_chunks,
            overlays,
        }
    }

    /// Effective chunk size for this column.
    pub fn chunk_rows(&self) -> u32 {
        self.chunk_rows
    }

    /// Number of chunks.
    pub fn chunk_count(&self) -> usize {
        self.base_chunks.len()
    }

    /// Total addressable row count = sum of base chunk lengths. Out-of-bounds reads beyond
    /// this still return `Value::Blank` (the column is logically open-ended at the top).
    pub fn row_count(&self) -> u64 {
        self.base_chunks.iter().map(|c| c.len() as u64).sum()
    }

    /// Read a single cell. Out-of-bounds returns `Value::Blank`.
    pub fn read(&self, row: RowId) -> Value {
        let (chunk_idx, rel_row) = self.locate(row);
        if chunk_idx >= self.base_chunks.len() {
            return Value::Blank;
        }
        // Overlay first.
        if let Some(v) = self.overlays[chunk_idx].get(rel_row) {
            return v.clone();
        }
        // Base second.
        let base = &self.base_chunks[chunk_idx];
        if (rel_row as usize) >= base.len() {
            // Within an under-sized last chunk's tail: read as Blank.
            return Value::Blank;
        }
        read_base(base.as_ref(), rel_row)
    }

    /// Write a cell via the overlay. Chunk autogrowth: if `row` is beyond all current chunks,
    /// allocate enough empty chunks to cover it (each new chunk is a `Float64Array` of null
    /// values; the overlay carries the real value). Matches the spreadsheet "open column"
    /// model: writing to A1000 of an empty column creates the chunks containing it.
    ///
    /// **Bound** (per opus arch F3): `row <= MAX_ROW` (Excel's 1,048,575). Beyond that, the
    /// autogrowth would allocate unbounded null chunks (up to 32 GB at u32::MAX). Panics
    /// rather than silently allocating.
    pub fn put(&mut self, row: RowId, value: Value) {
        assert!(
            row <= MAX_ROW,
            "ColumnStore::put: row {row} exceeds Excel max row {MAX_ROW}"
        );
        let (chunk_idx, rel_row) = self.locate(row);
        // Allocate empty chunks up to chunk_idx if needed.
        while chunk_idx >= self.base_chunks.len() {
            self.base_chunks.push(empty_chunk(self.chunk_rows));
            self.overlays.push(SparseOverlay::new());
        }
        self.overlays[chunk_idx].put(rel_row, value);
    }

    /// Replace an entire chunk's base with a new Arrow array, clearing the overlay for that
    /// chunk. Used by the recompute path: the new base is the materialized result column.
    ///
    /// Validates (per codex r13 N2):
    /// - `chunk_idx` is in bounds.
    /// - New array is `Float64Array` (Phase 0 limit).
    /// - New array length matches the existing chunk's length exactly (no resize via replace).
    pub fn replace_chunk(&mut self, chunk_idx: usize, new_base: ArrayRef) {
        assert!(
            chunk_idx < self.base_chunks.len(),
            "replace_chunk: chunk_idx {chunk_idx} out of bounds (have {} chunks)",
            self.base_chunks.len()
        );
        assert!(
            new_base.as_any().downcast_ref::<Float64Array>().is_some(),
            "replace_chunk: new base has type {:?}; Phase 0 requires Float64Array",
            new_base.data_type()
        );
        let old_len = self.base_chunks[chunk_idx].len();
        assert!(
            new_base.len() == old_len,
            "replace_chunk: new len {} != existing chunk len {old_len}",
            new_base.len()
        );
        self.base_chunks[chunk_idx] = new_base;
        self.overlays[chunk_idx].clear();
    }

    /// Append a new base chunk (with an empty overlay). Used during initial column build.
    ///
    /// Validates: new chunk is `Float64Array`; existing last chunk (if any) was exactly
    /// `chunk_rows` long (no appending after a short tail); new chunk length is
    /// `<= chunk_rows`.
    pub fn append_chunk(&mut self, base: ArrayRef) {
        assert!(
            base.as_any().downcast_ref::<Float64Array>().is_some(),
            "append_chunk: new chunk has type {:?}; Phase 0 requires Float64Array",
            base.data_type()
        );
        assert!(
            base.len() <= self.chunk_rows as usize,
            "append_chunk: new chunk len {} exceeds chunk_rows {}",
            base.len(),
            self.chunk_rows
        );
        if let Some(last) = self.base_chunks.last() {
            assert!(
                last.len() == self.chunk_rows as usize,
                "append_chunk: cannot append after a short tail chunk (last len {}, expected exactly {})",
                last.len(),
                self.chunk_rows
            );
        }
        self.base_chunks.push(base);
        self.overlays.push(SparseOverlay::new());
    }

    /// Borrow a chunk's base array. Useful for direct kernel access on the hot path.
    pub fn base_chunk(&self, chunk_idx: usize) -> Option<&ArrayRef> {
        self.base_chunks.get(chunk_idx)
    }

    /// Borrow a chunk's overlay. Useful for compaction passes that re-materialize base+overlay.
    pub fn overlay(&self, chunk_idx: usize) -> Option<&SparseOverlay> {
        self.overlays.get(chunk_idx)
    }

    /// Locate `(chunk_idx, rel_row)` for an absolute `row`.
    fn locate(&self, row: RowId) -> (usize, RowId) {
        let chunk_idx = (row / self.chunk_rows) as usize;
        let rel_row = row % self.chunk_rows;
        (chunk_idx, rel_row)
    }
}

impl Default for ColumnStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Read a single value from a base Arrow array at chunk-relative `rel_row`.
///
/// **Phase 0 only handles `Float64Array`.** Per codex r13 N7 + opus arch F4 + founder's
/// "No Fallbacks" rule (CLAUDE.md): unsupported array types MUST fail visibly, not return
/// `Value::Blank`. Phase 1+ will add Boolean/String/integer-typed base chunks; until then,
/// any non-Float64 base is a construction-time bug and panics on read.
fn read_base(base: &dyn Array, rel_row: RowId) -> Value {
    let arr = base
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap_or_else(|| {
            panic!(
                "ColumnStore::read_base: Phase 0 only supports Float64Array bases; got {:?}. \
                 Construct columns with `from_chunks(_, vec![Arc::new(Float64Array::from(...))])` \
                 or wait for Phase 1+ to add other types.",
                base.data_type()
            )
        });
    let idx = rel_row as usize;
    if idx >= arr.len() {
        return Value::Blank;
    }
    if arr.is_null(idx) {
        return Value::Blank;
    }
    // Use the safe Value::number constructor — sanitizes NaN/Inf into #NUM!.
    Value::number(arr.value(idx))
}

/// Construct an empty chunk of `chunk_rows` length, filled with nulls. Used by `put`'s
/// autogrowth path. Stored as a nullable Float64Array (Phase 0 base type); the overlay
/// carries the real value where one was written.
fn empty_chunk(chunk_rows: u32) -> ArrayRef {
    let null_iter = (0..chunk_rows).map(|_| None::<f64>);
    Arc::new(Float64Array::from_iter(null_iter)) as ArrayRef
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_types::ErrorValue;

    fn float64_chunk(values: &[f64]) -> ArrayRef {
        Arc::new(Float64Array::from(values.to_vec())) as ArrayRef
    }

    // -- chunk_rows_from_env ---------------------------------------------------

    // -- chunk_rows resolution (env-pure tests; never mutates process env) ---

    #[test]
    fn resolve_chunk_rows_unset_returns_default() {
        assert_eq!(resolve_chunk_rows(None), DEFAULT_CHUNK_ROWS);
    }

    #[test]
    fn resolve_chunk_rows_valid_value() {
        assert_eq!(resolve_chunk_rows(Some("2048")), 2048);
        assert_eq!(resolve_chunk_rows(Some("16384")), 16384);
    }

    // -- FIX-2: N8 — invalid QBOOK_CHUNK_ROWS must fail loudly, not silently default ---

    #[test]
    #[should_panic(expected = "not a u32")]
    fn resolve_chunk_rows_non_numeric_panics() {
        let _ = resolve_chunk_rows(Some("abc")); // expected panic
    }

    #[test]
    #[should_panic(expected = "must be > 0")]
    fn resolve_chunk_rows_zero_panics() {
        let _ = resolve_chunk_rows(Some("0")); // expected panic
    }

    #[test]
    #[should_panic(expected = "not a u32")]
    fn resolve_chunk_rows_empty_panics() {
        let _ = resolve_chunk_rows(Some("")); // empty string isn't a valid u32
    }

    // -- FIX-2: N7 + F4 — non-Float64 base panics, not silent Blank --------

    #[test]
    #[should_panic(expected = "Phase 0 requires Float64Array")]
    fn from_chunks_panics_on_non_float64() {
        let s: Arc<dyn arrow_array::Array> =
            Arc::new(arrow_array::StringArray::from(vec!["a", "b"]));
        let _ = ColumnStore::from_chunks(2, vec![s]);
    }

    // -- FIX-2: N2 — chunk invariants enforced (non-last must be exactly chunk_rows) ---

    #[test]
    #[should_panic(expected = "non-last chunk")]
    fn from_chunks_panics_on_undersized_non_last_chunk() {
        // 2-chunk column with chunk_rows=4 — first chunk SHORT (len=3) — should panic.
        let short = float64_chunk(&[1.0, 2.0, 3.0]); // len 3
        let normal = float64_chunk(&[4.0, 5.0, 6.0, 7.0]); // len 4
        let _ = ColumnStore::from_chunks(4, vec![short, normal]);
    }

    #[test]
    #[should_panic(expected = "exceeds chunk_rows")]
    fn from_chunks_panics_on_oversized_chunk() {
        let too_big = float64_chunk(&[1.0, 2.0, 3.0, 4.0, 5.0]); // len 5, max 4
        let _ = ColumnStore::from_chunks(4, vec![too_big]);
    }

    // -- FIX-2: F3 — ColumnStore::put rejects row > MAX_ROW ---

    #[test]
    #[should_panic(expected = "exceeds Excel max row")]
    fn put_panics_on_row_beyond_max_excel() {
        use ql_types::MAX_ROW;
        let mut c = ColumnStore::with_chunk_rows(16);
        c.put(MAX_ROW + 1, Value::Number(1.0));
    }

    #[test]
    fn put_at_excel_max_row_is_accepted() {
        use ql_types::MAX_ROW;
        let mut c = ColumnStore::with_chunk_rows(16);
        c.put(MAX_ROW, Value::Number(42.0));
        assert_eq!(c.read(MAX_ROW), Value::Number(42.0));
    }

    // -- FIX-2: N2 — replace_chunk validates new base ---

    #[test]
    #[should_panic(expected = "Phase 0 requires Float64Array")]
    fn replace_chunk_panics_on_non_float64() {
        let mut c = ColumnStore::from_chunks(4, vec![float64_chunk(&[1.0, 2.0, 3.0, 4.0])]);
        let bad: Arc<dyn arrow_array::Array> =
            Arc::new(arrow_array::StringArray::from(vec!["a"; 4]));
        c.replace_chunk(0, bad);
    }

    #[test]
    #[should_panic(expected = "new len")]
    fn replace_chunk_panics_on_length_mismatch() {
        let mut c = ColumnStore::from_chunks(4, vec![float64_chunk(&[1.0, 2.0, 3.0, 4.0])]);
        c.replace_chunk(0, float64_chunk(&[1.0, 2.0])); // shorter — panic
    }

    // -- ColumnStore construction ----------------------------------------------

    #[test]
    fn new_is_empty() {
        let c = ColumnStore::with_chunk_rows(16);
        assert_eq!(c.chunk_count(), 0);
        assert_eq!(c.row_count(), 0);
        assert_eq!(c.read(0), Value::Blank);
        assert_eq!(c.read(999_999), Value::Blank);
    }

    #[test]
    fn from_chunks_initializes_overlays() {
        let c = ColumnStore::from_chunks(4, vec![float64_chunk(&[1.0, 2.0, 3.0, 4.0])]);
        assert_eq!(c.chunk_count(), 1);
        assert_eq!(c.row_count(), 4);
        assert_eq!(c.overlay(0).unwrap().len(), 0);
    }

    // -- read base path --------------------------------------------------------

    #[test]
    fn read_first_chunk_base() {
        let c = ColumnStore::from_chunks(4, vec![float64_chunk(&[10.0, 20.0, 30.0, 40.0])]);
        assert_eq!(c.read(0), Value::Number(10.0));
        assert_eq!(c.read(1), Value::Number(20.0));
        assert_eq!(c.read(3), Value::Number(40.0));
    }

    #[test]
    fn read_crosses_chunks() {
        let c = ColumnStore::from_chunks(
            4,
            vec![
                float64_chunk(&[1.0, 2.0, 3.0, 4.0]),
                float64_chunk(&[5.0, 6.0, 7.0, 8.0]),
            ],
        );
        assert_eq!(c.read(3), Value::Number(4.0)); // last of chunk 0
        assert_eq!(c.read(4), Value::Number(5.0)); // first of chunk 1
        assert_eq!(c.read(7), Value::Number(8.0));
        assert_eq!(c.read(8), Value::Blank); // beyond
    }

    #[test]
    fn read_short_last_chunk_tail_is_blank() {
        // Last chunk has 2 values; capacity 4. Rows 2, 3 read as Blank.
        let c = ColumnStore::from_chunks(4, vec![float64_chunk(&[1.0, 2.0])]);
        assert_eq!(c.read(0), Value::Number(1.0));
        assert_eq!(c.read(1), Value::Number(2.0));
        assert_eq!(c.read(2), Value::Blank);
        assert_eq!(c.read(3), Value::Blank);
    }

    #[test]
    fn read_base_nan_returns_num_error() {
        // Bare NaN in the base array → Value::number sanitizes to #NUM!.
        let c = ColumnStore::from_chunks(4, vec![float64_chunk(&[f64::NAN, 1.0, 2.0, 3.0])]);
        assert_eq!(c.read(0), Value::Error(ErrorValue::Num));
        assert_eq!(c.read(1), Value::Number(1.0));
    }

    // -- overlay precedence ----------------------------------------------------

    #[test]
    fn overlay_takes_precedence_over_base() {
        let mut c = ColumnStore::from_chunks(4, vec![float64_chunk(&[1.0, 2.0, 3.0, 4.0])]);
        c.put(1, Value::Number(99.0));
        assert_eq!(c.read(1), Value::Number(99.0));
        assert_eq!(c.read(0), Value::Number(1.0)); // others untouched
        assert_eq!(c.read(2), Value::Number(3.0));
    }

    #[test]
    fn overlay_supports_heterogeneous_value() {
        let mut c = ColumnStore::from_chunks(4, vec![float64_chunk(&[1.0, 2.0, 3.0, 4.0])]);
        c.put(0, Value::text("oops"));
        c.put(1, Value::Boolean(true));
        c.put(2, Value::Error(ErrorValue::Ref));
        c.put(3, Value::Blank);
        assert_eq!(c.read(0), Value::text("oops"));
        assert_eq!(c.read(1), Value::Boolean(true));
        assert_eq!(c.read(2), Value::Error(ErrorValue::Ref));
        assert_eq!(c.read(3), Value::Blank);
    }

    // -- put autogrowth --------------------------------------------------------

    #[test]
    fn put_into_empty_column_autogrows_chunks() {
        let mut c = ColumnStore::with_chunk_rows(4);
        // Writing to row 10 → needs chunks 0, 1, 2 (chunk_idx 2 covers rows 8..12).
        c.put(10, Value::Number(123.0));
        assert_eq!(c.chunk_count(), 3);
        assert_eq!(c.read(10), Value::Number(123.0));
        // Surrounding rows in those chunks: base is null → Blank.
        assert_eq!(c.read(0), Value::Blank);
        assert_eq!(c.read(9), Value::Blank);
        assert_eq!(c.read(11), Value::Blank);
    }

    // -- replace_chunk ---------------------------------------------------------

    #[test]
    fn replace_chunk_swaps_base_clears_overlay() {
        let mut c = ColumnStore::from_chunks(4, vec![float64_chunk(&[1.0, 2.0, 3.0, 4.0])]);
        c.put(2, Value::Number(99.0));
        assert_eq!(c.read(2), Value::Number(99.0));
        c.replace_chunk(0, float64_chunk(&[100.0, 200.0, 300.0, 400.0]));
        // Overlay is cleared; new base shows through.
        assert_eq!(c.read(2), Value::Number(300.0));
        assert_eq!(c.read(0), Value::Number(100.0));
        assert_eq!(c.overlay(0).unwrap().len(), 0);
    }

    // -- locate ----------------------------------------------------------------

    #[test]
    fn locate_at_chunk_boundary() {
        // Boundary math via behavior: reads at boundary multiples must dispatch correctly.
        // Construct 3 chunks of 16 each (=48 rows), populate at boundary cells.
        let mut c = ColumnStore::from_chunks(
            16,
            vec![
                float64_chunk(&[0.0; 16]),
                float64_chunk(&[0.0; 16]),
                float64_chunk(&[0.0; 16]),
            ],
        );
        c.put(0, Value::Number(1.0));
        c.put(15, Value::Number(2.0));
        c.put(16, Value::Number(3.0));
        c.put(31, Value::Number(4.0));
        c.put(32, Value::Number(5.0));
        c.put(47, Value::Number(6.0));
        assert_eq!(c.read(0), Value::Number(1.0));
        assert_eq!(c.read(15), Value::Number(2.0));
        assert_eq!(c.read(16), Value::Number(3.0));
        assert_eq!(c.read(31), Value::Number(4.0));
        assert_eq!(c.read(32), Value::Number(5.0));
        assert_eq!(c.read(47), Value::Number(6.0));
        // sanity: locate via behavior — 47 is in chunk 2 with rel_row 15
    }

    #[test]
    fn append_chunk_grows_correctly() {
        let mut c = ColumnStore::with_chunk_rows(4);
        c.append_chunk(float64_chunk(&[1.0, 2.0, 3.0, 4.0]));
        assert_eq!(c.chunk_count(), 1);
        c.append_chunk(float64_chunk(&[5.0, 6.0, 7.0, 8.0]));
        assert_eq!(c.chunk_count(), 2);
        assert_eq!(c.read(7), Value::Number(8.0));
    }

    // -- proptest --------------------------------------------------------------
    use proptest::prelude::*;

    proptest! {
        /// Invariant: read(row) after put(row, v) returns v, regardless of:
        ///   - chunk size (1..1024)
        ///   - row offset (0..100_000)
        ///   - intermediate edits to other rows
        ///   - heterogeneous value variants
        #[test]
        fn put_then_read_round_trips(
            chunk_rows in 1u32..1024,
            row in 0u32..100_000,
            other_rows in proptest::collection::vec(0u32..100_000, 0..16),
            // Heterogeneous Value (no NaN/Inf — Value::number sanitizes those).
            n in proptest::num::f64::POSITIVE | proptest::num::f64::NEGATIVE | proptest::num::f64::ZERO,
            b in any::<bool>(),
        ) {
            let mut c = ColumnStore::with_chunk_rows(chunk_rows);
            // Apply other writes first.
            for r in other_rows {
                c.put(r, Value::Number(b as i32 as f64));
            }
            let v = if b { Value::Number(n) } else { Value::Boolean(false) };
            c.put(row, v.clone());
            // After v's put, read(row) must equal v EVEN IF a later other-row write
            // was at `row` (proptest doesn't guarantee uniqueness). We re-put just before
            // the read to lock the value.
            c.put(row, v.clone());
            // Sanitize NaN/Inf to match Value::number's semantics.
            let expected = match &v {
                Value::Number(x) if x.is_nan() || x.is_infinite() => Value::Error(ErrorValue::Num),
                _ => v.clone(),
            };
            let got = c.read(row);
            prop_assert!(got == expected || got == v, "got {got:?}, expected {expected:?} or {v:?}");
        }

        /// Invariant: read(row) for a never-written row is Value::Blank when the column has
        /// no chunks, regardless of row.
        #[test]
        fn read_empty_column_is_blank(row in 0u32..1_000_000) {
            let c = ColumnStore::with_chunk_rows(16);
            prop_assert_eq!(c.read(row), Value::Blank);
        }
    }
}
