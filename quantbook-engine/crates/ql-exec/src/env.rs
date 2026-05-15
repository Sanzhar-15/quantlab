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

    /// **W5-117 (Phase 4.8.G.2):** the formula's own cell address, if
    /// the env was constructed with one. Used by the structured-ref
    /// `[@Col]` row-narrowing path in scalar.rs. Default impl returns
    /// `None` — only `WorkbookEnv::with_formula_cell` overrides.
    fn formula_cell_for_sref(&self) -> Option<ql_types::Address> {
        None
    }
}

/// `ql-storage::Workbook`-backed implementation. Wraps a Workbook reference; reads dispatch
/// via the Workbook's sheet lookup + the sheet's `read(row, col)`.
///
/// **W5-71 (Phase 4.5.A.2):** caches an `EvalContext` built from the
/// workbook's `date_system` at construction time.
///
/// **W5-153 (post-4.9.O):** also wires `workbook.locale()` (added by
/// W5-133 / Phase 4.9.A) through to `EvalContext.locale`. The W5-71
/// comment that this would happen in "Phase 4.9" was true at the
/// architecture level but Phase 4.9 (W5-138 → W5-152) shipped the
/// workbook-side accessor + op-log integration without updating
/// this constructor. Closing the gap retroactively.
///
/// `NowProvider` stays at the default (`System`) — wired by
/// Phase-6.3 WASM bindings when those land.
pub struct WorkbookEnv<'w> {
    workbook: &'w ql_storage::Workbook,
    eval_ctx: EvalContext,
    /// **W5-117 (Phase 4.8.G.2):** the formula's own cell address, if
    /// known. Used by the eval-side `ExprPlan::StructuredRef` arm to
    /// narrow `[@Col]` forms (resolved is the full column data range;
    /// eval narrows row to `formula_cell.row` if it falls inside the
    /// range). `None` for paths without cell context (legacy callers,
    /// tests).
    formula_cell: Option<ql_types::Address>,
}

impl<'w> WorkbookEnv<'w> {
    pub fn new(workbook: &'w ql_storage::Workbook) -> Self {
        // **W5-153 (post-4.9.O):** wire workbook.locale() through.
        // Pre-fix, eval-side EvalContext.locale was always EnUs
        // regardless of workbook.set_locale() calls. No production
        // function reads EvalContext.locale today, so the gap was
        // latent rather than a correctness bug, but any future
        // locale-aware eval function (e.g. locale-sensitive TEXT()
        // formatting) now sees the right locale.
        let eval_ctx = EvalContext {
            date_system: workbook.date_system(),
            locale: workbook.locale(),
            ..EvalContext::default()
        };
        Self {
            workbook,
            eval_ctx,
            formula_cell: None,
        }
    }

    /// **W5-117 (Phase 4.8.G.2):** WorkbookEnv variant that carries the
    /// formula's own cell. Used at eval time when the caller knows
    /// the cell (set_formula, recompute_dirty, recompute_all,
    /// validate_formula).
    pub fn with_formula_cell(workbook: &'w ql_storage::Workbook, cell: ql_types::Address) -> Self {
        let mut env = Self::new(workbook);
        env.formula_cell = Some(cell);
        env
    }

    /// **W5-117 (Phase 4.8.G.2):** the formula's cell address, if the
    /// env was constructed with one. Used by the structured-ref `[@Col]`
    /// narrowing path in scalar.rs.
    pub fn formula_cell(&self) -> Option<ql_types::Address> {
        self.formula_cell
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

    /// **W5-117 (Phase 4.8.G.2):** the formula's own cell address, if
    /// constructed via `with_formula_cell`. The scalar.rs StructuredRef
    /// `[@Col]` arm uses this for row narrowing.
    fn formula_cell_for_sref(&self) -> Option<ql_types::Address> {
        self.formula_cell
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
    /// Legacy single-table lookup. Ignores `owning_sheet` — used by tests
    /// that don't need the sheet-scoped chain, and by the legacy
    /// `bind_with_names` entry point. Production callers should pass
    /// `&Workbook` (see the blanket impl below) so sheet-scoped names
    /// resolve correctly per Phase 4.6.D § 7.3.
    fn lookup_named_target(
        &self,
        name: &str,
        _owning_sheet: ql_types::SheetId,
    ) -> Option<ResolvedName> {
        named_target_to_resolved(self.lookup_ci(name)?)
    }
}

/// **W5-92 (Phase 4.6.D):** the production `NameLookup` impl —
/// `&Workbook` does the two-tier sheet-then-workbook chain per
/// design doc § 7.3:
///
/// 1. If `owning_sheet`'s `scoped_names` table has the name, return it.
/// 2. Else, fall back to the workbook-scoped `NameTable`.
///
/// This matches Excel's resolution rule: sheet-scoped names shadow
/// workbook-scoped names with the same identifier when accessed from a
/// formula on that sheet. The production binder call sites pass
/// `&self.workbook` for the `names` argument; legacy callers that
/// passed `self.workbook.names()` get workbook-only behavior (no chain
/// walk) and won't see sheet-scoped names.
impl NameLookup for ql_storage::Workbook {
    fn lookup_named_target(
        &self,
        name: &str,
        owning_sheet: ql_types::SheetId,
    ) -> Option<ResolvedName> {
        // Tier 1: sheet-scoped lookup against the owning sheet.
        if let Some(sheet) = self.sheet(owning_sheet) {
            if let Some(target) = sheet.scoped_names().lookup_ci(name) {
                return named_target_to_resolved(target);
            }
        }
        // Tier 2: workbook-scoped fallback.
        named_target_to_resolved(self.names().lookup_ci(name)?)
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

/// **W5-115 (Phase 4.8.F):** the production `TableLookup` impl —
/// `&Workbook` resolves table names via `Workbook::lookup_table` (the
/// case-insensitive lookup against `TableTable` added in Phase 4.8.A).
/// Production callers pass `&self.workbook` as the `&dyn TableLookup`
/// argument to `bind_with_site`.
impl crate::plan::TableLookup for ql_storage::Workbook {
    fn lookup_table(&self, name: &str) -> Option<&ql_storage::TableMetadata> {
        self.lookup_table(name)
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

    // ===== W5-92 (Phase 4.6.D) NameLookup for Workbook chain =====

    #[test]
    fn name_lookup_for_workbook_resolves_workbook_scoped() {
        let mut wb = ql_storage::Workbook::new();
        wb.add_sheet("S");
        wb.set_name("R", NamedTarget::Constant(Value::Number(0.5)))
            .unwrap();
        let resolved = NameLookup::lookup_named_target(&wb, "R", 0);
        assert!(matches!(resolved, Some(ResolvedName::Number(n)) if n == 0.5));
    }

    #[test]
    fn name_lookup_for_workbook_resolves_sheet_scoped_only() {
        let mut wb = ql_storage::Workbook::new();
        wb.add_sheet("S0");
        wb.sheet_mut(0)
            .unwrap()
            .set_scoped_name("R", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        let resolved = NameLookup::lookup_named_target(&wb, "R", 0);
        assert!(matches!(resolved, Some(ResolvedName::Number(n)) if n == 0.21));
    }

    #[test]
    fn name_lookup_for_workbook_sheet_scoped_shadows_workbook_scoped() {
        // XS-4-03 acceptance: sheet-scoped beats workbook-scoped at the
        // owning sheet's lookup. From other sheets, workbook-scoped wins.
        let mut wb = ql_storage::Workbook::new();
        wb.add_sheet("S0");
        wb.add_sheet("S1");
        wb.set_name("R", NamedTarget::Constant(Value::Number(0.05)))
            .unwrap();
        wb.sheet_mut(0)
            .unwrap()
            .set_scoped_name("R", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();

        // Lookup from sheet 0 → sheet-scoped 0.21 wins.
        let r0 = NameLookup::lookup_named_target(&wb, "R", 0);
        assert!(
            matches!(r0, Some(ResolvedName::Number(n)) if n == 0.21),
            "expected 0.21 (sheet-scoped) from S0, got {r0:?}"
        );
        // Lookup from sheet 1 → workbook-scoped 0.05 wins (S1 has no
        // scoped "R").
        let r1 = NameLookup::lookup_named_target(&wb, "R", 1);
        assert!(
            matches!(r1, Some(ResolvedName::Number(n)) if n == 0.05),
            "expected 0.05 (workbook-scoped fallback) from S1, got {r1:?}"
        );
    }

    #[test]
    fn name_lookup_for_workbook_unknown_name_returns_none() {
        let mut wb = ql_storage::Workbook::new();
        wb.add_sheet("S");
        let resolved = NameLookup::lookup_named_target(&wb, "Missing", 0);
        assert!(resolved.is_none());
    }

    #[test]
    fn name_lookup_for_workbook_owning_sheet_out_of_range_falls_back() {
        // Defensive: if `owning_sheet` is OOR (loader/test path), we
        // can't walk the scoped table — fall back to workbook-scoped.
        // No panic.
        let mut wb = ql_storage::Workbook::new();
        wb.add_sheet("S");
        wb.set_name("R", NamedTarget::Constant(Value::Number(7.0)))
            .unwrap();
        let resolved = NameLookup::lookup_named_target(&wb, "R", 99);
        assert!(matches!(resolved, Some(ResolvedName::Number(n)) if n == 7.0));
    }

    /// **W5-153 (post-4.9.O):** `WorkbookEnv::new` wires
    /// `workbook.locale()` through to `EvalContext.locale`. Pre-fix,
    /// the eval-side locale was always EnUs regardless of
    /// `workbook.set_locale` calls (latent — no production function
    /// currently reads `EvalContext.locale`, but the gap would have
    /// surfaced the moment any locale-aware eval landed).
    #[test]
    fn workbook_env_new_propagates_workbook_locale_to_eval_context() {
        let mut wb = ql_storage::Workbook::new();
        wb.add_sheet("S");
        wb.set_locale(ql_types::Locale::De);
        let env = WorkbookEnv::new(&wb);
        assert_eq!(env.eval_context().locale, ql_types::Locale::De);
    }

    #[test]
    fn workbook_env_new_default_locale_is_en_us() {
        let mut wb = ql_storage::Workbook::new();
        wb.add_sheet("S");
        let env = WorkbookEnv::new(&wb);
        assert_eq!(env.eval_context().locale, ql_types::Locale::EnUs);
    }
}
