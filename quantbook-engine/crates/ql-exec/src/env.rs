//! Cell-read environment for the scalar evaluator.
//!
//! The evaluator needs to look up cell values when it encounters `ExprPlan::CellRef`.
//! Rather than coupling to `ql-storage::Workbook` directly, we abstract via a trait so:
//!
//! - Test harnesses can supply a `HashMap`-backed fake environment.
//! - The Week 4+ runtime can wrap a real `Workbook` + `ColumnStore` chain.
//! - Future cross-workbook references (Phase 6+) can implement the trait against an
//!   external dataset adapter.
//!
//! The trait is intentionally narrow: just `read_cell`. Sheet-/column-bulk reads belong on
//! `ql-storage` directly and the SIMD path (W4-2) doesn't go through this trait at all —
//! it reads Arrow chunks via `ColumnStore::iter_chunks` for batch processing.

use ql_storage::{NameTable, NamedTarget};
use ql_types::{ColId, ErrorValue, Range, RowId, SheetId, Value};

use crate::plan::{NameLookup, ResolvedName};

/// Read a single cell value. Out-of-bounds reads return `Value::Blank` per Excel semantics.
pub trait CellEnv {
    fn read_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Value;

    /// Phase 3.6 (2026-05-12) — AGG-3-04 entry point. Materialize a range
    /// into a flat `Vec<Value>` for aggregate functions (SUM, AVERAGE,
    /// MIN, MAX, COUNT, PRODUCT). Default impl iterates the range row by
    /// row using `read_cell`; impls that have cheaper bounds info (e.g.
    /// `WorkbookEnv` clamps to `Sheet::bounds`) override.
    ///
    /// Returns an empty Vec for a degenerate range (e.g. range entirely
    /// outside a sheet's populated area). The aggregate function then
    /// applies its empty-input rule (MIN/MAX → 0; AVERAGE → `#DIV/0!`;
    /// SUM/COUNT/PRODUCT → 0 or 1; see `ql-functions::scalar_fns`).
    fn read_range(&self, range: Range) -> Vec<Value> {
        let mut out = Vec::new();
        for row in range.start_row..=range.end_row {
            for col in range.start_col..=range.end_col {
                out.push(self.read_cell(range.sheet, row, col));
            }
            // Safety: end_row could be `RowId::MAX` (whole-column); the
            // outer range syntax must be bounded by the caller. The
            // default impl iterates to completion — the WorkbookEnv
            // override clamps to `Sheet::bounds().row_extent`.
        }
        out
    }
}

/// `ql-storage::Workbook`-backed implementation. Wraps a Workbook reference; reads dispatch
/// via the Workbook's sheet lookup + the sheet's `read(row, col)`.
pub struct WorkbookEnv<'w> {
    workbook: &'w ql_storage::Workbook,
}

impl<'w> WorkbookEnv<'w> {
    pub fn new(workbook: &'w ql_storage::Workbook) -> Self {
        Self { workbook }
    }
}

impl<'w> CellEnv for WorkbookEnv<'w> {
    fn read_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Value {
        // Phase 2A.7 audit H6 (2026-05-12): out-of-bounds sheet now surfaces
        // `Value::Error(ErrorValue::Ref)` — Excel's canonical `#REF!`. Prior
        // behavior silently mapped missing-sheet to `Value::Blank`, which
        // hid stale-sheet refs in saved formulas (e.g., a formula authored
        // against Sheet3 in a workbook later truncated to 2 sheets). Two
        // megaudit agents flagged the silent fallback. Within an existing
        // sheet, missing cells still return `Blank` — that's correct Excel
        // canon for "empty cell."
        match self.workbook.sheet(sheet) {
            Some(s) => s.read(row, col),
            None => Value::Error(ErrorValue::Ref),
        }
    }

    /// Phase 3.6 override: clamps the iteration to `Sheet::bounds` so a
    /// `SUM(A:A)` named range with `end_row = RowId::MAX` reads only the
    /// populated rows (typically a few hundred thousand at most on a
    /// real sheet), not all 4 billion `RowId` slots. Without this clamp
    /// AGG-3-04 would correctness-pass but AGG-3-03 (full-column-still-
    /// usable) would hang at evaluation time.
    fn read_range(&self, range: Range) -> Vec<Value> {
        let Some(sheet) = self.workbook.sheet(range.sheet) else {
            return vec![Value::Error(ErrorValue::Ref)];
        };
        let bounds = sheet.bounds();
        // bounds extents are "one past max"; convert to inclusive bounds.
        if bounds.row_extent == 0 || bounds.col_extent == 0 {
            return Vec::new();
        }
        let max_row = bounds.row_extent - 1;
        let max_col = bounds.col_extent - 1;
        let end_row = range.end_row.min(max_row);
        let end_col = range.end_col.min(max_col);
        if range.start_row > end_row || range.start_col > end_col {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(
            ((end_row - range.start_row + 1) as usize)
                .saturating_mul((end_col - range.start_col + 1) as usize),
        );
        for row in range.start_row..=end_row {
            for col in range.start_col..=end_col {
                out.push(sheet.read(row, col));
            }
        }
        out
    }
}

/// HashMap-backed env for tests + simple harnesses. Stores `((sheet, row, col), Value)`
/// triples; missing keys return `Value::Blank` per Excel semantics.
#[derive(Clone, Debug, Default)]
pub struct MapEnv {
    cells: std::collections::HashMap<(SheetId, RowId, ColId), Value>,
}

impl MapEnv {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
        self.cells.insert((sheet, row, col), value);
    }
}

impl CellEnv for MapEnv {
    fn read_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Value {
        self.cells
            .get(&(sheet, row, col))
            .cloned()
            .unwrap_or(Value::Blank)
    }
}

// Phase 2A.1 (2026-05-12): NameTable → NameLookup wiring so the binder can resolve
// `Expr::NameRef` against the workbook's name table. Keeps ql-exec's `plan` module
// agnostic to ql-storage (the trait lives there); this impl bridges them in env.rs
// where ql-storage is already imported.
//
// Phase 2A.6 audit H2: use `lookup_ci` so the binder is robust against callers
// who bypass parser-side canonicalization. The parser already uppercases names in
// `Expr::NameRef`, so this is a safety net for hand-constructed ASTs / tests; it
// removes a case-sensitivity footgun without breaking any happy path.
impl NameLookup for NameTable {
    fn lookup_named_target(&self, name: &str) -> Option<ResolvedName> {
        named_target_to_resolved(self.lookup_ci(name)?)
    }
}

/// Project a `NamedTarget` into the binder-side `ResolvedName` vocabulary. Phase
/// 2A.6 audit M2/M3: `Constant(Blank)` and `Constant(Error)` now map to distinct
/// `ResolvedName` variants (the binder converts them to specific `BindError`
/// kinds) — previously they were silently coerced to `Text("")` and `None`
/// respectively, both of which violate the no-fallbacks rule.
fn named_target_to_resolved(target: NamedTarget) -> Option<ResolvedName> {
    match target {
        NamedTarget::Cell(addr) => Some(ResolvedName::Cell(
            addr.sheet, addr.row, addr.col,
            // NamedTarget::Cell stores Address (sheet/row/col) but not abs flags.
            // Per Excel canon, named-range targets are ALWAYS absolute (the name
            // doesn't shift on copy). Set both abs to true.
            true, true,
        )),
        NamedTarget::Constant(Value::Number(n)) => Some(ResolvedName::Number(n)),
        NamedTarget::Constant(Value::Boolean(b)) => Some(ResolvedName::Bool(b)),
        NamedTarget::Constant(Value::Text(s)) => Some(ResolvedName::Text(s)),
        NamedTarget::Constant(Value::Blank) => Some(ResolvedName::Blank),
        NamedTarget::Constant(Value::Error(e)) => Some(ResolvedName::ErrorValue(e)),
        // Phase 2B.4 (2026-05-12): carry Range / formula-text payload so the
        // context-aware binder doesn't have to re-look-up the name to
        // produce `ExprPlan::AggregateNameRef`.
        NamedTarget::Range(range) => Some(ResolvedName::Range(range)),
        NamedTarget::Formula(text) => Some(ResolvedName::Formula(text)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_env_blank_for_missing() {
        let e = MapEnv::new();
        assert_eq!(e.read_cell(0, 0, 0), Value::Blank);
    }

    #[test]
    fn map_env_roundtrip() {
        let mut e = MapEnv::new();
        e.put(0, 5, 3, Value::Number(42.0));
        assert_eq!(e.read_cell(0, 5, 3), Value::Number(42.0));
        assert_eq!(e.read_cell(0, 5, 2), Value::Blank);
    }

    /// Phase 2A.7 audit H6 (2026-05-12): missing-sheet reads return `#REF!`,
    /// not `Blank`. (Was previously a silent Phase-3-deferred fallback.)
    #[test]
    fn workbook_env_ref_error_for_missing_sheet() {
        let wb = ql_storage::Workbook::new();
        let e = WorkbookEnv::new(&wb);
        assert_eq!(e.read_cell(99, 0, 0), Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn workbook_env_reads_existing_cell() {
        let mut wb = ql_storage::Workbook::new();
        let sheet_id = wb.add_sheet("S1");
        wb.sheet_mut(sheet_id)
            .unwrap()
            .put(5, 3, Value::Number(7.0));
        let e = WorkbookEnv::new(&wb);
        assert_eq!(e.read_cell(sheet_id, 5, 3), Value::Number(7.0));
        assert_eq!(e.read_cell(sheet_id, 0, 0), Value::Blank);
    }
}
