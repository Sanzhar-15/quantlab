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
use ql_types::{
    ColId, ErrorValue, EvalContext, Range, RowId, SheetId, Value, DEFAULT_EVAL_CONTEXT,
};

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

    /// **W5-54 (range-aware functions, GAP-F-05 follow-up):** return
    /// the flat `Vec<Value>` for the range PLUS its 2D shape (rows,
    /// cols). For range-aware functions like VLOOKUP/INDEX which
    /// need to address by `(row, col)`, the dispatcher uses this to
    /// construct `FnArg::Range { values, rows, cols }`.
    ///
    /// `rows * cols == values.len()` is the invariant. If the env
    /// clamps to sheet bounds (`WorkbookEnv`), the returned shape
    /// reflects the clamped dimensions. The default impl below
    /// returns the unclamped shape derived from the range bounds —
    /// matching the unclamped `read_range` default.
    fn read_range_with_shape(&self, range: Range) -> (Vec<Value>, usize, usize) {
        let values = self.read_range(range);
        let rows = (range.end_row - range.start_row + 1) as usize;
        let cols = (range.end_col - range.start_col + 1) as usize;
        debug_assert_eq!(rows.saturating_mul(cols), values.len());
        (values, rows, cols)
    }

    /// **W5-69 (Phase 4.5.A.0):** the evaluator context for date /
    /// locale / clock-aware function dispatch. Default impl returns
    /// `&DEFAULT_EVAL_CONTEXT` (Excel1900 + EnUs + System), suitable
    /// for tests, MapEnv, and benches that don't carry workbook state.
    /// `WorkbookEnv` overrides this with the workbook's actual
    /// `date_system` field once Sub-phase 4.5.A adds it.
    fn eval_context(&self) -> &EvalContext {
        &DEFAULT_EVAL_CONTEXT
    }
}

/// `ql-storage::Workbook`-backed implementation. Wraps a Workbook reference; reads dispatch
/// via the Workbook's sheet lookup + the sheet's `read(row, col)`.
///
/// **W5-71 (Phase 4.5.A.2):** caches an `EvalContext` built from the
/// workbook's `date_system` at construction time. Locale + NowProvider
/// stay at their defaults (`EnUs` + `System`) — Phase 4.9 + future
/// Phase-6.3 WASM bindings will plumb those through too.
pub struct WorkbookEnv<'w> {
    workbook: &'w ql_storage::Workbook,
    eval_ctx: EvalContext,
}

impl<'w> WorkbookEnv<'w> {
    pub fn new(workbook: &'w ql_storage::Workbook) -> Self {
        let eval_ctx = EvalContext {
            date_system: workbook.date_system(),
            ..EvalContext::default()
        };
        Self { workbook, eval_ctx }
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

    /// W5-54 / W5-60: shape handling for explicit vs open-ended ranges.
    ///
    /// Two cases:
    /// - **Open-ended** (whole-column / whole-row, end_row or end_col at
    ///   `RowId::MAX` / `ColId::MAX`): clamp to sheet bounds. Shape and
    ///   values reflect the populated subset. This is the W5-54 behavior
    ///   for aggregate scans like `SUM(A:A)` over a sparse column.
    /// - **Bounded explicit** (every coordinate < MAX): preserve the
    ///   REQUESTED shape; pad out-of-bounds cells with `Value::Blank`.
    ///   W5-60 fix per the W5-49→W5-58 mega-audit: shape-aware functions
    ///   (INDEX / VLOOKUP / HLOOKUP / SUMIFS / SUMPRODUCT) rely on the
    ///   shape matching the user's explicit range bounds. The W5-54
    ///   clamp behavior produced `#REF!` for `INDEX(A1:B10, 10, 2)` when
    ///   row 10 was blank because shape shrank to the populated subset.
    fn read_range_with_shape(&self, range: Range) -> (Vec<Value>, usize, usize) {
        let Some(sheet) = self.workbook.sheet(range.sheet) else {
            return (vec![Value::Error(ErrorValue::Ref)], 1, 1);
        };
        let is_open_ended =
            range.end_row == ql_types::RowId::MAX || range.end_col == ql_types::ColId::MAX;
        if is_open_ended {
            // Clamp to bounds (existing W5-54 behavior for SUM(A:A)
            // and similar whole-column / whole-row aggregate scans).
            let bounds = sheet.bounds();
            if bounds.row_extent == 0 || bounds.col_extent == 0 {
                return (Vec::new(), 0, 0);
            }
            let max_row = bounds.row_extent - 1;
            let max_col = bounds.col_extent - 1;
            let end_row = range.end_row.min(max_row);
            let end_col = range.end_col.min(max_col);
            if range.start_row > end_row || range.start_col > end_col {
                return (Vec::new(), 0, 0);
            }
            let rows = (end_row - range.start_row + 1) as usize;
            let cols = (end_col - range.start_col + 1) as usize;
            let mut out = Vec::with_capacity(rows.saturating_mul(cols));
            for row in range.start_row..=end_row {
                for col in range.start_col..=end_col {
                    out.push(sheet.read(row, col));
                }
            }
            (out, rows, cols)
        } else {
            // Bounded explicit range: preserve requested shape; pad
            // out-of-bounds cells with Blank. The user asked for
            // exactly A1:B10; even if only A1:A5 is populated, the
            // shape must remain 10×2 so INDEX / VLOOKUP /
            // SUMIFS / SUMPRODUCT see the layout the user authored.
            let rows = (range.end_row - range.start_row + 1) as usize;
            let cols = (range.end_col - range.start_col + 1) as usize;
            let mut out = Vec::with_capacity(rows.saturating_mul(cols));
            for row in range.start_row..=range.end_row {
                for col in range.start_col..=range.end_col {
                    out.push(sheet.read(row, col));
                }
            }
            (out, rows, cols)
        }
    }

    /// **W5-71 (Phase 4.5.A.2):** return the cached `EvalContext` built
    /// from the workbook's `date_system` at WorkbookEnv construction.
    /// Overrides the trait default (which returns
    /// `&DEFAULT_EVAL_CONTEXT`).
    fn eval_context(&self) -> &EvalContext {
        &self.eval_ctx
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

/// **W5-90 (Phase 4.6.B):** the production `SheetResolver` impl —
/// `&Workbook` resolves sheet names via `Workbook::sheet_id_by_name`
/// (the canonicalizing case-insensitive lookup added in W5-86).
/// Production callers (`WorkbookRuntime`, `WorkbookTransaction`,
/// `CalcgraphSession`) pass `&self.workbook` as the `&dyn SheetResolver`
/// argument to `bind_with_names_and_sheets`.
impl crate::plan::SheetResolver for ql_storage::Workbook {
    fn resolve_sheet(&self, name: &str) -> Option<ql_types::SheetId> {
        self.sheet_id_by_name(name)
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

    // ===== W5-71 Phase 4.5.A.2 — WorkbookEnv carries date_system =====

    #[test]
    fn workbook_env_eval_context_reflects_default_excel1900() {
        let wb = ql_storage::Workbook::new();
        let e = WorkbookEnv::new(&wb);
        assert_eq!(
            e.eval_context().date_system,
            ql_types::DateSystem::Excel1900
        );
    }

    #[test]
    fn workbook_env_eval_context_reflects_excel1904_workbook() {
        let mut wb = ql_storage::Workbook::new();
        wb.set_date_system(ql_types::DateSystem::Excel1904);
        let e = WorkbookEnv::new(&wb);
        assert_eq!(
            e.eval_context().date_system,
            ql_types::DateSystem::Excel1904
        );
    }

    #[test]
    fn map_env_eval_context_is_default_excel1900() {
        // MapEnv (test harness, no workbook backing) uses the trait default.
        let e = MapEnv::new();
        assert_eq!(
            e.eval_context().date_system,
            ql_types::DateSystem::Excel1900
        );
    }
}
