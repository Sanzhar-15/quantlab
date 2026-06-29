//! `WorkbookRuntime` — the live-formula facade per Phase 1 W5-10.
//!
//! Ties the lex → parse → bind → eval → put pipeline together so callers (IDE,
//! tests, future REPL) get one method that does the right thing for a user-typed
//! formula. Plus a `recompute_all` method that re-evaluates every formula cell in
//! the workbook — used after loading a `.qbook/` directory where formula values
//! were left as `#NULL!` sentinels.
//!
//! Phase 1 W5-10 scope:
//! - `set_formula(sheet, row, col, text)` — parse + eval + persist formula text +
//!   evaluated value. Phase 3.5: routes the evaluated value to the COMPUTED
//!   overlay; clears any stale user-overlay entry at the cell first.
//! - `set_value(sheet, row, col, value)` — literal-only write; clears any existing
//!   formula association. Phase 3.5: `clear_formula` cascades to drop the
//!   computed-overlay entry too.
//! - `recompute_all()` — HashMap-order full pass. Tier C1 (2026-05-18,
//!   Phase 4.12 Opus-B H-2 closure) added an ephemeral
//!   `CalcgraphSession`-based cycle-detection pre-pass: cycled cells
//!   short-circuit to `#CIRC!` before the eval loop runs. Acyclic
//!   formulas still evaluate in HashMap order (GAP-R-01 stale-
//!   intermediate caveat unchanged).
//! - `recompute_dirty()` (Phase 3.4 W5-37) — incremental graph-driven recompute.
//!   Runs Tarjan SCC over the attached `CalcgraphSession`'s dirty set; cycled
//!   members get `Value::Error(ErrorValue::Circ)`. Phase 3.6 routes aggregates
//!   through the session's `InMemAggregateCache`; Phase 3.8 applies value-
//!   equality short-circuit; Phase 3.9 V1 tallies SIMD-eligible formulas in
//!   `RecomputeResult.simd_classified`.
//! - `validate_formula(sheet, row, col, text)` (Phase 2B.7) — full pipeline
//!   without mutation; IDE on-keystroke validation entry.
//!
//! Phase 4+ deferred (per Phase 3.10 megaudit + W5-48 Codex deep-audit):
//! - GAP-G-01 / GAP-G-03 — append-only graph rebind staleness + range-deps-
//!   not-scheduler-edges. Architectural decision needed before Phase 4.3 V2.
//! - GAP-G-02 — bulk SIMD region dispatch from graph scheduler (V1 is
//!   observability only).
//! - FN4-03 — lazy IF/IFERROR/IFNA/IFS ✅ CLOSED (w142): `scalar.rs::eval_lazy_logical`
//!   evaluates only the selected branch/fallback; dep discovery still walks all args.
//! - Cross-sheet formula references via NameTable resolution (Phase 4.6).

use std::cell::RefCell;

use ql_functions::format::FormatString;
use ql_functions::FunctionRegistry;
use ql_oplog::OpLog;
use ql_storage::{FormatId, Workbook};
use ql_types::{ColId, RowId, SheetId, MAX_COLUMN, MAX_ROW};
use ql_udf::UdfWorker;

use crate::env::UdfCellDiagnostic;
use crate::plan_cache::{PlanCache, PlanCacheStats};

// **Tier D1 (2026-05-18) — Phase 5 prep monolith split.** Sibling
// submodules under `crate::workbook_runtime`. Each adds an
// `impl<'a> WorkbookRuntime<'a>` block extending the same struct
// without changing the public API. Full per-step history with
// commit hashes lives in `docs/PHASE-4-V2-BACKLOG.md` § D1; design
// in `docs/architecture/workbook-runtime-split-design.md`.
mod cells;
mod charts;
mod config;
mod error;
mod formats;
mod names;
mod recompute;
mod sheets;
mod styles;
mod tables;
mod validate;
mod visibility;
pub use error::{RecomputeFailure, RecomputeResult, RuntimeError};
// **R9 / Wave C (2026-06-18):** the read-only decimal-nudge compute, shared by
// `WorkbookRuntime::nudge_cell_decimals` (apply) and the session's read-only
// `nudge_decimals_preview` (the IDE's batched multi-cell path).
pub(crate) use formats::compute_nudged_format;

/// Phase 2A.6 audit H1/L4 (2026-05-12) helper. Confirms `sheet` is in range
/// before any work that would otherwise panic inside `Workbook::put_at`.
///
/// **Tier D1 audit L-1 closure (2026-05-18):** tightened from
/// `pub(crate)` to private. The original comment claimed
/// `WorkbookTransaction` needed it, but `WorkbookTransaction`
/// actually imports `validate_cell` (which internally calls
/// `validate_sheet`), not `validate_sheet` directly. No external
/// caller exists.
fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
    let count = workbook.sheet_count();
    if (sheet as usize) >= count {
        return Err(RuntimeError::InvalidSheet {
            sheet,
            sheet_count: count,
        });
    }
    Ok(())
}

/// Phase 2A.7 audit H1 (2026-05-12) helper. Combines sheet validation with
/// row/col bounds checks so the runtime entry points refuse out-of-grid
/// coordinates before any work that would otherwise panic inside
/// `Sheet::put` (which asserts `row <= MAX_ROW && col <= MAX_COLUMN`). The
/// Phase 2A.6 audit closed sheet-id panics but missed row/col — three
/// independent megaudit agents flagged the gap. `pub(crate)` so
/// `WorkbookTransaction` can call the same validator at buffer time.
///
/// **Tier D1 Step 3.3 doc-attachment fix:** this doc block was
/// previously misattached to a `rewrite_formula_text_for_sheet_rename`
/// helper that lived between this comment and `validate_cell`. The
/// helper moved to `sheets.rs` along with `rename_sheet`, so the doc
/// now reaches its intended target.
pub(crate) fn validate_cell(
    workbook: &Workbook,
    sheet: SheetId,
    row: RowId,
    col: ColId,
) -> Result<(), RuntimeError> {
    validate_sheet(workbook, sheet)?;
    if row > MAX_ROW {
        return Err(RuntimeError::InvalidCell {
            sheet,
            row,
            col,
            why: "row exceeds MAX_ROW (1,048,575)",
        });
    }
    if col > MAX_COLUMN {
        return Err(RuntimeError::InvalidCell {
            sheet,
            row,
            col,
            why: "col exceeds MAX_COLUMN (16,383)",
        });
    }
    Ok(())
}

/// Live-formula facade. Wraps a `&mut Workbook` + `&FunctionRegistry`.
///
/// Construct one per session of cell edits. Re-creating per call is cheap (the
/// struct holds borrows, no heap state of its own).
///
/// Phase 2A.3.b (2026-05-12): optionally attach an `OpLog` via
/// `WorkbookRuntime::with_oplog`. When attached, `set_value` and `set_formula`
/// emit ops into the log in append-before-mutate order. `transaction()`
/// re-borrows the op-log handle into the returned transaction so a single op
/// log records both individual edits and batched commits cohesively.
pub struct WorkbookRuntime<'a> {
    workbook: &'a mut Workbook,
    registry: &'a FunctionRegistry,
    /// Optional op-log sink. When `Some`, all producer methods append before
    /// mutating the workbook so a failing append leaves the workbook
    /// unchanged. When `None`, the runtime behaves exactly as Phase 1 W5-10.
    oplog: Option<&'a mut OpLog>,
    /// Phase 2B.3 bind-plan cache. Lives for the runtime's lifetime;
    /// successive `set_formula` and `recompute_all` calls hit the cache
    /// for unchanged formula text under the same NameTable generation.
    /// See `crate::plan_cache` module docs for the invalidation contract.
    plan_cache: PlanCache,
    /// Phase 3.1 (2026-05-12) optional calcgraph session. When `Some`,
    /// every mutation method calls the corresponding hook on the
    /// session AFTER the workbook mutation succeeds. Phase 3.1 hooks
    /// are stubs (counter bumps + cell-index updates); Phase 3.3 wires
    /// dirty propagation through the same surface. See
    /// `crate::calcgraph_session` module docs for the ownership model.
    graph: Option<&'a mut crate::CalcgraphSession>,
    /// **W5-82 (Phase 4.5.D part 6):** parsed `FormatString` cache keyed
    /// by `FormatId`. `read_display` populates on-demand from
    /// `Workbook::formats()` lookup; `FormatTable::register_at` rejects
    /// id→string mutations, so cache entries stay stable for the
    /// runtime's lifetime. A new `RegisterFormat` op merely inserts a
    /// new entry; no invalidation needed.
    format_cache: std::collections::HashMap<FormatId, FormatString>,
    /// **6.4-3c (2026-05-29):** borrowed handle to the session's out-of-process
    /// Python-UDF worker, or `None` when no worker is configured (every
    /// non-session constructor, plus a session that never called
    /// `set_udf_worker`). Threaded into the value-computing env at the
    /// `set_formula` / recompute sites (`with_formula_cell_and_worker`) so a
    /// `=MYUDF(A1)` dispatches to the worker; the binding-only `validate` path
    /// leaves it unused. The session owns the `RefCell<Box<dyn UdfWorker + Send>>`; the
    /// runtime only borrows it (single-threaded — `RefCell` is `!Sync`).
    udf_worker: Option<&'a RefCell<Box<dyn UdfWorker + Send>>>,
    /// **6.4-3d (2026-05-29; megaudit blocker G):** borrowed per-recompute
    /// collector for UDF-dispatch diagnostics, lent by the session alongside
    /// `udf_worker`. Threaded into the value-computing env (recompute /
    /// `set_formula`) so a failed `=MYUDF(..)` records WHY; `None` for every
    /// non-session constructor (binding-only / standalone-transaction paths).
    /// The session owns the `RefCell<Vec<_>>` and drains it after the runtime
    /// borrow ends (single-threaded — `RefCell` is `!Sync`).
    udf_diagnostics: Option<&'a RefCell<Vec<UdfCellDiagnostic>>>,
    /// **6.4B (item H):** the operation-level UDF time-budget deadline for the
    /// in-progress recompute pass. Armed by the session's recalc entry
    /// ([`WorkbookSession::run_recalc`]) via [`arm_udf_op_deadline`] to
    /// `Instant::now() + udf_op_budget` — only when a worker is attached — then
    /// threaded into each per-cell recompute env via [`WorkbookEnv::with_op_deadline`].
    /// `None` outside a worker-backed recompute pass (so non-UDF / no-worker
    /// recompute is byte-for-byte unchanged, and direct `rt.recompute_*()` test
    /// callers keep the per-call deadline only).
    ///
    /// [`arm_udf_op_deadline`]: WorkbookRuntime::arm_udf_op_deadline
    op_deadline: Option<std::time::Instant>,
    /// **H3 (6.3-0):** borrowed per-edit collector for spill-footprint TARGET
    /// cells (the NON-anchor cells of a dynamic-array spill) touched by a DIRECT
    /// mutation (`set_formula` materializing a new spill, `set_value`/`clear`
    /// dissolving one). The owning [`WorkbookSession`] lends its
    /// `RefCell<Vec<_>>` here (cleared at each `with_runtime` entry) and folds
    /// the drained coords into its delta change-log alongside the anchor — so
    /// `snapshot_delta` reports the full footprint, not just the anchor. `None`
    /// for every non-session constructor (binding-only / standalone paths).
    /// Pushed to ONLY from the direct-mutation primitives, never from
    /// `write_spill` (shared with recompute) nor the recompute loop — the
    /// recompute path records footprints through `RecomputeResult.changed_cells`
    /// instead. Mirrors [`udf_diagnostics`] (single-threaded — `RefCell` is
    /// `!Sync`).
    ///
    /// [`WorkbookSession`]: crate::session::WorkbookSession
    /// [`udf_diagnostics`]: WorkbookRuntime::udf_diagnostics
    spill_footprint: Option<&'a RefCell<Vec<(SheetId, RowId, ColId)>>>,
}

impl<'a> WorkbookRuntime<'a> {
    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
        Self {
            workbook,
            registry,
            oplog: None,
            plan_cache: PlanCache::new(),
            format_cache: std::collections::HashMap::new(),
            graph: None,
            udf_worker: None,
            udf_diagnostics: None,
            op_deadline: None,
            spill_footprint: None,
        }
    }

    /// Phase 2A.3.b: construct a runtime that records every mutation to the
    /// supplied `OpLog`. Producer-replay equivalence: replaying the resulting
    /// log against a fresh workbook (then calling `recompute_all` to
    /// materialize formula values) reproduces the same observable state.
    ///
    /// See module docs for the documented limitations: `set_value(Value::Blank)`
    /// emits no `PutValue` (CellWireValue lacks a Blank variant in 2A.3.b);
    /// NaN/Inf in number values fail serde_json serialization and surface as
    /// `RuntimeError::OpLog`.
    pub fn with_oplog(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        oplog: &'a mut OpLog,
    ) -> Self {
        Self {
            workbook,
            registry,
            oplog: Some(oplog),
            plan_cache: PlanCache::new(),
            format_cache: std::collections::HashMap::new(),
            graph: None,
            udf_worker: None,
            udf_diagnostics: None,
            op_deadline: None,
            spill_footprint: None,
        }
    }

    /// Phase 3.1 (2026-05-12): construct a runtime that fires calcgraph
    /// mutation hooks on every producer method. Phase 3.1 hooks are
    /// stubs (counter bumps + cell-index updates) — they accumulate
    /// state that Phase 3.3 will turn into real dirty propagation and
    /// edge updates. Today's recompute_all still walks formulas in
    /// HashMap order; Phase 3.4 replaces it with a Tarjan-SCC-scheduled
    /// graph walk.
    pub fn with_graph(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        graph: &'a mut crate::CalcgraphSession,
    ) -> Self {
        Self {
            workbook,
            registry,
            oplog: None,
            plan_cache: PlanCache::new(),
            format_cache: std::collections::HashMap::new(),
            graph: Some(graph),
            udf_worker: None,
            udf_diagnostics: None,
            op_deadline: None,
            spill_footprint: None,
        }
    }

    /// Phase 3.1 (2026-05-12): construct a runtime with BOTH an attached
    /// op log and an attached calcgraph session. The combined-attachment
    /// constructor mirrors the IDE pattern (open file → load oplog +
    /// rebuild graph → hand both to the runtime per edit). Order of
    /// operations per mutation: lex+parse+bind → op-log append → workbook
    /// mutation → graph hook.
    pub fn with_oplog_and_graph(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        oplog: &'a mut OpLog,
        graph: &'a mut crate::CalcgraphSession,
    ) -> Self {
        Self {
            workbook,
            registry,
            oplog: Some(oplog),
            plan_cache: PlanCache::new(),
            format_cache: std::collections::HashMap::new(),
            graph: Some(graph),
            udf_worker: None,
            udf_diagnostics: None,
            op_deadline: None,
            spill_footprint: None,
        }
    }

    /// **Phase 6.1B inc.2 (2026-05-26) — session-owned plan cache.**
    /// Construct a runtime that takes ownership of a caller-supplied
    /// `PlanCache` (instead of allocating a fresh one) AND attaches both
    /// an op-log and a calcgraph session. The owning `WorkbookSession`
    /// (`crate::session::WorkbookSession`) holds the long-lived
    /// `PlanCache` and threads it through a per-edit runtime via this
    /// constructor + [`into_plan_cache`], so the cache (and its
    /// hit/miss stats) survive across edits even though the runtime
    /// borrow window is reconstructed per command.
    ///
    /// This is the bottom-up realization of GAP-PS-09 / `docs/api/
    /// session-api.md` §2.1 LOW-1: WorkbookSession owns
    /// `Workbook + OpLog + CalcgraphSession + PlanCache + FunctionRegistry`
    /// and constructs the per-edit `WorkbookRuntime` internally so no
    /// borrow crosses an FFI boundary.
    ///
    /// Ownership-transfer (vs the borrow-a-`&mut PlanCache` shape the
    /// design doc sketched) keeps every existing `self.plan_cache` call
    /// site and the field type unchanged — `PlanCache: Default`, so the
    /// session `mem::take`s its cache in, runs the edit, and recovers the
    /// warmed cache via [`into_plan_cache`]. The `format_cache` is still
    /// fresh per edit (a re-parse cost only; correctness unaffected) —
    /// session-owning it is a later refinement.
    ///
    /// [`into_plan_cache`]: WorkbookRuntime::into_plan_cache
    // The session lends several disjoint borrowed handles (op-log, graph,
    // plan-cache, UDF worker, UDF-diagnostics, spill-footprint collector) — a
    // constructor legitimately taking each is clearer than a bundling struct
    // here. (Crossed the clippy 7-arg threshold when the H3 spill-footprint
    // collector was added at 6.3-0.)
    #[allow(clippy::too_many_arguments)]
    pub fn with_session_state(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        oplog: &'a mut OpLog,
        graph: &'a mut crate::CalcgraphSession,
        plan_cache: PlanCache,
        // **6.4-3c (2026-05-29):** borrowed handle to the session's Python-UDF
        // worker (`None` when none configured). Threaded into the eval env so
        // `=MYUDF(A1)` dispatches; mirrors the `plan_cache` threading style.
        udf_worker: Option<&'a RefCell<Box<dyn UdfWorker + Send>>>,
        // **6.4-3d (2026-05-29; blocker G):** the per-recompute UDF-diagnostic
        // collector, lent alongside the worker.
        udf_diagnostics: Option<&'a RefCell<Vec<UdfCellDiagnostic>>>,
        // **H3 (6.3-0):** the per-edit spill-footprint collector, lent so direct
        // mutations surface their full spill footprint into the delta change-log.
        spill_footprint: Option<&'a RefCell<Vec<(SheetId, RowId, ColId)>>>,
    ) -> Self {
        Self {
            workbook,
            registry,
            oplog: Some(oplog),
            plan_cache,
            format_cache: std::collections::HashMap::new(),
            graph: Some(graph),
            udf_worker,
            udf_diagnostics,
            op_deadline: None,
            spill_footprint,
        }
    }

    /// **Phase 6.1B inc.2c-4 (2026-05-27) — `batch` detached-op-log path.**
    /// Same as [`with_session_state`] but with the op-log **detached**
    /// (`oplog = None`). Every mutator then updates the workbook AND
    /// maintains the calcgraph session — the graph hooks fire on
    /// `self.graph.is_some()`, independent of the op-log — but appends **no**
    /// per-op entries (each producer gates its append on
    /// `self.oplog.as_deref_mut()`).
    ///
    /// This is the load-bearing primitive for `WorkbookSession::batch`
    /// (option (a), impl-plan §0): the session builds + appends ONE
    /// `Op::BatchCommit` itself, then applies the buffered ops through this
    /// graph-maintaining-but-silent runtime so the result is exactly one
    /// op-log entry (one undo unit, §3.4) with the session graph kept live
    /// (the tension `WorkbookTransaction` could not resolve — it maintains
    /// no graph). The session's `PlanCache` is threaded through (recovered
    /// via [`into_plan_cache`]) so the batch warms the same cache as
    /// single edits.
    ///
    /// [`with_session_state`]: WorkbookRuntime::with_session_state
    /// [`into_plan_cache`]: WorkbookRuntime::into_plan_cache
    pub fn with_session_state_no_oplog(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        graph: &'a mut crate::CalcgraphSession,
        plan_cache: PlanCache,
        // **6.4-3c (2026-05-29):** see `with_session_state`.
        udf_worker: Option<&'a RefCell<Box<dyn UdfWorker + Send>>>,
        // **6.4-3d (2026-05-29; blocker G):** see `with_session_state`.
        udf_diagnostics: Option<&'a RefCell<Vec<UdfCellDiagnostic>>>,
        // **H3 (6.3-0):** see `with_session_state`.
        spill_footprint: Option<&'a RefCell<Vec<(SheetId, RowId, ColId)>>>,
    ) -> Self {
        Self {
            workbook,
            registry,
            oplog: None,
            plan_cache,
            format_cache: std::collections::HashMap::new(),
            graph: Some(graph),
            udf_worker,
            udf_diagnostics,
            op_deadline: None,
            spill_footprint,
        }
    }

    /// **Phase 6.1B inc.2 (2026-05-26).** Consume the runtime and return
    /// its (now warmed) `PlanCache` so the owning session can retain it
    /// for the next edit. Pairs with [`with_session_state`].
    ///
    /// [`with_session_state`]: WorkbookRuntime::with_session_state
    /// **6.4B (item H):** arm the operation-level UDF budget deadline for the
    /// recompute pass about to run through this runtime. Called by the session's
    /// recalc entry with `Some(Instant::now() + budget)` when a worker is attached,
    /// `None` otherwise. The per-cell recompute env-build site reads [`op_deadline`]
    /// and threads it to the dispatch site via [`WorkbookEnv::with_op_deadline`].
    ///
    /// [`op_deadline`]: WorkbookRuntime::op_deadline
    pub fn arm_udf_op_deadline(&mut self, deadline: Option<std::time::Instant>) {
        self.op_deadline = deadline;
    }

    pub fn into_plan_cache(self) -> PlanCache {
        self.plan_cache
    }

    /// Phase 2B.3: snapshot of cumulative bind-plan-cache observability
    /// since this runtime was constructed. Includes hit count, miss
    /// count, entry count, and convenience hit-rate.
    pub fn cache_stats(&self) -> PlanCacheStats {
        self.plan_cache.stats()
    }
}
