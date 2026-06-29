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

use std::cell::RefCell;
use std::time::Instant;

use ql_functions::{ReferenceQuery, NO_OP_REFERENCE_QUERY};
use ql_storage::{NameTable, NamedTarget};
use ql_types::{
    ColId, ErrorValue, EvalContext, Range, RowId, SheetId, Value, DEFAULT_EVAL_CONTEXT,
};
use ql_udf::UdfWorker;

use crate::plan::{NameLookup, ResolvedName};

/// **6.4-3d (2026-05-29; megaudit blocker G):** a structured per-cell
/// diagnostic emitted by the UDF dispatch site when a `=MYUDF(..)` fails (or
/// has no worker). Deliberately a ql-exec-local, `ql_session`-free type so the
/// eval layer ([`crate::scalar::dispatch_udf`]) stays decoupled from the session
/// DTOs; the owning [`crate::session::WorkbookSession`] converts it to a
/// `ql_session::dto::Diagnostic` (severity `Error`) and emits an
/// `Event::CellDiagnostic` when it drains the per-recompute collector. The cell
/// VALUE is unchanged (still `#CALC!`/`#TIMEOUT!`); this is purely additive so a
/// failed UDF explains *why* (exit test 7). `code` is a stable `&'static str`
/// (`udf_no_worker` / `udf_raised` / `udf_timeout` / `udf_worker_died` /
/// `udf_cancelled` / `udf_handshake` / `udf_protocol` / `udf_codec`); for
/// `udf_raised`, `message` carries `"{exc_type}: {message}"`.
#[derive(Clone, Debug, PartialEq)]
pub struct UdfCellDiagnostic {
    /// The formula cell the failing UDF lives in.
    pub addr: ql_types::Address,
    /// Stable diagnostic code (maps 1:1 from the [`ql_udf::UdfError`] variant /
    /// the no-worker case).
    pub code: &'static str,
    /// Human-readable detail.
    pub message: String,
}

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

    /// **Wave G2 (engine-filter):** is `row` hidden on `sheet`? The default is
    /// `false` — envs that carry no workbook visibility (`MapEnv`, benches,
    /// tests) treat every row as visible. `WorkbookEnv` overrides to consult
    /// `Sheet::is_row_hidden`. The scalar.rs materializer reads this to build the
    /// `SUBTOTAL(101..=111)` row-visibility mask. A non-existent sheet has no
    /// hidden rows (mirrors `read_cell`'s missing-sheet → `Blank`).
    fn is_row_hidden(&self, _sheet: SheetId, _row: RowId) -> bool {
        false
    }

    /// **Wave G2:** does `sheet` have ANY hidden rows? A cheap gate so the
    /// materializer skips building a visibility mask for the (overwhelmingly
    /// common) all-visible sheet — keeping every non-`SUBTOTAL` range read
    /// byte-identical to pre-Wave-G2. Default `false`; `WorkbookEnv` overrides.
    fn sheet_has_hidden_rows(&self, _sheet: SheetId) -> bool {
        false
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

    /// **W5-RT-1 (RT-V1-01):** workbook-introspection accessor for the
    /// reference-aware dispatch tier (ISFORMULA / FORMULATEXT). Default
    /// returns a no-op singleton; `WorkbookEnv` overrides to delegate to
    /// its underlying `&Workbook` via `Workbook::formula_at`.
    ///
    /// Test envs (`MapEnv`) and any env without workbook backing inherit
    /// the default — `is_formula_at` returns `false`, `formula_text_at`
    /// returns `None`. Tests that exercise ISFORMULA / FORMULATEXT must
    /// use `WorkbookEnv` (standard for cell-boundary tests).
    fn reference_query(&self) -> &dyn ReferenceQuery {
        &NO_OP_REFERENCE_QUERY
    }

    /// **6.4-3c (2026-05-29):** the out-of-process Python-UDF worker, if one
    /// is configured for this eval. The `RegisteredFn`-dispatch site in
    /// `scalar.rs` reaches the worker through this accessor and calls it from
    /// the UDF arm (a `=MYUDF(A1)` whose name resolves via
    /// `registry.udf_handle`).
    ///
    /// Returns a `&RefCell<Box<dyn UdfWorker + Send>>` rather than `&mut` because the
    /// whole eval stack threads `&self` (shared) env references — interior
    /// mutability bridges that to `UdfWorker::call`'s `&mut self`. The
    /// `RefCell` borrow is taken only AFTER all args are evaluated (so a nested
    /// `=MYUDF(MYUDF2(A1))` releases the inner borrow before the outer one) and
    /// is held across the single blocking IPC round-trip, which never re-enters
    /// eval (the worker is a leaf). Single-threaded: `RefCell` is `!Sync`, and
    /// the SIMD/rayon aggregate path bypasses `CellEnv` entirely.
    ///
    /// Default `None`: tests, `MapEnv`, benches, and any workbook opened
    /// without a worker. A registered UDF with no worker is a deterministic
    /// `#CALC!` at the dispatch site (No-Fallbacks — a visible error, never a
    /// panic), NOT a silent no-op.
    fn udf_worker(&self) -> Option<&RefCell<Box<dyn UdfWorker + Send>>> {
        None
    }

    /// **6.4-3d (2026-05-29; megaudit blocker G):** record a UDF-dispatch
    /// diagnostic for the current formula cell. Default is a no-op — only
    /// [`WorkbookEnv`] built via [`WorkbookEnv::with_formula_cell_worker_and_diagnostics`]
    /// with a collector present actually retains it (the value-computing
    /// recompute / `set_formula` sites). `MapEnv`, benches, the binding-only
    /// `validate` path, and the standalone-transaction commit path all inherit
    /// the no-op — their UDF failures still produce the correct cell VALUE,
    /// just no diagnostic event. Same defaulted-method shape as [`udf_worker`].
    ///
    /// [`udf_worker`]: CellEnv::udf_worker
    fn push_udf_diagnostic(&self, _diag: UdfCellDiagnostic) {}

    /// **6.4B (item H):** the operation-level UDF time-budget deadline for the
    /// current recompute pass, if one is armed. [`dispatch_udf`] clamps each call's
    /// timeout to `min(per-call, remaining-budget)` and, once `now >= deadline`,
    /// skips the worker entirely — a deterministic `#TIMEOUT!` + `udf_budget_exhausted`
    /// diagnostic — so a sheet full of slow UDFs cannot stall ONE recompute for
    /// N×(per-call deadline).
    ///
    /// Default `None`: no budget armed (single-cell `set_formula`, tests, `MapEnv`,
    /// the standalone-transaction commit path) — the per-call deadline alone
    /// applies, exactly as before. Only the value-computing recompute pass
    /// ([`WorkbookRuntime::recompute_dirty`] / `recompute_all`) arms it, via
    /// [`WorkbookEnv::with_op_deadline`].
    ///
    /// [`dispatch_udf`]: crate::scalar
    /// [`WorkbookRuntime::recompute_dirty`]: crate::workbook_runtime::WorkbookRuntime
    fn udf_op_deadline(&self) -> Option<Instant> {
        None
    }

    /// **Wave P (2026-06-20):** the lexical local-binding scope (LET / LAMBDA)
    /// active for the current sub-expression. Default is the EMPTY env — the
    /// grid envs (`WorkbookEnv`, `MapEnv`, benches) carry no locals, so the
    /// overwhelmingly common non-LET/LAMBDA eval path is byte-identical and
    /// pays nothing. Only the eval-time `LocalScopedEnv` (built by the
    /// `ExprPlan::Let` / `ExprPlan::CallLambda` arms in `scalar.rs`) overrides
    /// this to thread a non-empty scope — which is how a `NameRef`-in-scope,
    /// lowered to `ExprPlan::LocalRef`, resolves WITHOUT a new parameter on the
    /// ~15 recursive `eval_scalar_with_cache` call sites (a missed thread there
    /// would be a SILENT stale-binding bug; routing scope through the env makes
    /// the compiler-checked delegation the single source of truth).
    fn local_env(&self) -> &crate::local_env::LocalEnv {
        static EMPTY: crate::local_env::LocalEnv = crate::local_env::LocalEnv::empty();
        &EMPTY
    }

    /// **Wave P (2026-06-20):** the current LAMBDA invocation depth, for the
    /// recursion guard. Default 0; only `LocalScopedEnv` (constructed at a
    /// `CallLambda` invocation) bumps it. Evaluation errors loudly past
    /// `MAX_LAMBDA_DEPTH` instead of overflowing the native stack — a closure
    /// passed to itself (`g(g, n)`) with no REACHABLE base case (e.g. the
    /// argument only ever grows, `g(g, n+1)`) recurses unboundedly.
    ///
    /// **FN4-03 (2026-06-29):** `IF` is now LAZY — a recursive lambda WITH a
    /// reachable base case (`IF(n<2, 1, n*self(self, n-1))`) terminates and
    /// computes correctly, because the recursive else-branch is no longer
    /// evaluated once the base condition holds (previously eager `IF` evaluated
    /// both branches, so even a correct base case ran to `MAX_LAMBDA_DEPTH` →
    /// `#NUM!`). The depth guard still bounds genuinely unbounded recursion.
    fn lambda_depth(&self) -> u32 {
        0
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
    /// **6.4-3c (2026-05-29):** borrowed handle to the session's Python-UDF
    /// worker, threaded in by the value-computing recompute / set_formula env
    /// sites (`workbook_runtime`). `None` for the binding-only / validate paths
    /// and for every legacy caller (`new` / `with_formula_cell`). Surfaced to
    /// the dispatch site via the `CellEnv::udf_worker` override below.
    udf_worker: Option<&'w RefCell<Box<dyn UdfWorker + Send>>>,
    /// **6.4-3d (2026-05-29; megaudit blocker G):** borrowed per-recompute
    /// collector the UDF dispatch site pushes a [`UdfCellDiagnostic`] into on a
    /// failed (or no-worker) `=MYUDF(..)`. `None` for every path without a
    /// session-owned collector (legacy ctors, `validate`, standalone txn). The
    /// session lends `&self.udf_diagnostics` and drains it into
    /// `Event::CellDiagnostic` after the runtime borrow ends. Interior-mutable
    /// + `!Sync` like `udf_worker`; sound under single-threaded recompute.
    udf_diagnostics: Option<&'w RefCell<Vec<UdfCellDiagnostic>>>,
    /// **6.4B (item H):** the operation-level UDF time-budget deadline for the
    /// recompute pass this env belongs to. `None` everywhere except the
    /// value-computing recompute pass, which sets it via [`WorkbookEnv::with_op_deadline`]
    /// from the runtime's pass-start deadline. Surfaced to the dispatch site through
    /// the [`CellEnv::udf_op_deadline`] override. `Copy` (`Instant`), so threading it
    /// per-cell is free and keeps `WorkbookSession: Send`.
    op_deadline: Option<Instant>,
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
            udf_worker: None,
            udf_diagnostics: None,
            // **6.4B (item H):** no op-budget by default; only the recompute pass
            // sets one via `with_op_deadline`.
            op_deadline: None,
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

    /// **6.4-3c (2026-05-29):** WorkbookEnv carrying BOTH the formula cell
    /// (for structured-ref narrowing) AND the session's Python-UDF worker (for
    /// `RegisteredFn::Udf` dispatch). Used by the value-computing recompute /
    /// set_formula env sites in `workbook_runtime` so a `=MYUDF(A1)` actually
    /// calls the worker. `worker` is `None` when the session has no worker
    /// configured — a registered UDF then evaluates to `#CALC!` at the dispatch
    /// site (No-Fallbacks-honest), never a panic.
    pub fn with_formula_cell_and_worker(
        workbook: &'w ql_storage::Workbook,
        cell: ql_types::Address,
        worker: Option<&'w RefCell<Box<dyn UdfWorker + Send>>>,
    ) -> Self {
        let mut env = Self::new(workbook);
        env.formula_cell = Some(cell);
        env.udf_worker = worker;
        env
    }

    /// **6.4-3d (2026-05-29; megaudit blocker G):** like
    /// [`with_formula_cell_and_worker`] but ALSO carries the session's
    /// per-recompute `UdfCellDiagnostic` collector, so a failed (or no-worker)
    /// `=MYUDF(..)` records a structured diagnostic the session drains into an
    /// `Event::CellDiagnostic`. Used by the value-computing recompute /
    /// `set_formula` env sites (`workbook_runtime`). The plain
    /// [`with_formula_cell_and_worker`] (used by the standalone-transaction
    /// commit path) leaves the collector `None` — its UDF failures still yield
    /// the correct cell value, just no diagnostic event.
    ///
    /// [`with_formula_cell_and_worker`]: WorkbookEnv::with_formula_cell_and_worker
    pub fn with_formula_cell_worker_and_diagnostics(
        workbook: &'w ql_storage::Workbook,
        cell: ql_types::Address,
        worker: Option<&'w RefCell<Box<dyn UdfWorker + Send>>>,
        diagnostics: Option<&'w RefCell<Vec<UdfCellDiagnostic>>>,
    ) -> Self {
        let mut env = Self::new(workbook);
        env.formula_cell = Some(cell);
        env.udf_worker = worker;
        env.udf_diagnostics = diagnostics;
        env
    }

    /// **6.4B (item H):** attach the operation-level UDF time-budget deadline for
    /// the current recompute pass (builder style so only the value-computing
    /// recompute site sets it; every other ctor leaves it `None`). Surfaced to the
    /// dispatch site via [`CellEnv::udf_op_deadline`]; `dispatch_udf` clamps each
    /// call to `min(per-call, remaining)` and skips the worker once the budget is
    /// spent.
    pub fn with_op_deadline(mut self, op_deadline: Option<Instant>) -> Self {
        self.op_deadline = op_deadline;
        self
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

    /// **Wave G2 (engine-filter):** consult the sheet's hidden-row set. A
    /// missing sheet has no hidden rows (returns `false`) — the materializer
    /// only calls this for a resolved `range.sheet`, and "not hidden" is the
    /// correct neutral answer regardless.
    fn is_row_hidden(&self, sheet: SheetId, row: RowId) -> bool {
        self.workbook
            .sheet(sheet)
            .is_some_and(|s| s.is_row_hidden(row))
    }

    /// **Wave G2:** cheap gate — does the sheet carry any hidden rows at all?
    fn sheet_has_hidden_rows(&self, sheet: SheetId) -> bool {
        self.workbook
            .sheet(sheet)
            .is_some_and(|s| !s.hidden_rows().is_empty())
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

    /// **W5-RT-1 (RT-V1-01):** workbook-introspection accessor for
    /// ISFORMULA / FORMULATEXT. `WorkbookEnv` implements
    /// `ReferenceQuery` directly (delegating to the underlying
    /// `&Workbook::formula_at`), so we return `self`.
    fn reference_query(&self) -> &dyn ReferenceQuery {
        self
    }

    /// **6.4-3c (2026-05-29):** surface the session-injected Python-UDF worker
    /// to the dispatch site. `Some` only when this env was built via
    /// `with_formula_cell_and_worker` with a configured worker.
    fn udf_worker(&self) -> Option<&RefCell<Box<dyn UdfWorker + Send>>> {
        self.udf_worker
    }

    /// **6.4-3d (2026-05-29; megaudit blocker G):** push into the borrowed
    /// per-recompute collector when one is present (set via
    /// `with_formula_cell_worker_and_diagnostics`); otherwise a no-op. The
    /// `borrow_mut` is taken for the single push only — `dispatch_udf` pushes
    /// once, AFTER the IPC round-trip, never re-entrantly — so there is no
    /// nested-borrow hazard.
    fn push_udf_diagnostic(&self, diag: UdfCellDiagnostic) {
        if let Some(sink) = self.udf_diagnostics {
            sink.borrow_mut().push(diag);
        }
    }

    /// **6.4B (item H):** surface the recompute pass's op-level UDF budget deadline
    /// (set via [`WorkbookEnv::with_op_deadline`]) to the dispatch site.
    fn udf_op_deadline(&self) -> Option<Instant> {
        self.op_deadline
    }
}

/// **W5-RT-1 (RT-V1-01):** `ReferenceQuery` impl for `WorkbookEnv`. Delegates to
/// `Workbook::formula_at`, which retains the canonicalized printer output (no
/// leading `=`); the `formula_text_at` impl prepends `=` so callers receive the
/// Excel-canonical FORMULATEXT shape directly.
impl<'w> ReferenceQuery for WorkbookEnv<'w> {
    fn is_formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> bool {
        self.workbook.formula_at(sheet, row, col).is_some()
    }

    fn formula_text_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<String> {
        self.workbook.formula_at(sheet, row, col).map(|arc| {
            let mut out = String::with_capacity(arc.len() + 1);
            out.push('=');
            out.push_str(arc.as_ref());
            out
        })
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
