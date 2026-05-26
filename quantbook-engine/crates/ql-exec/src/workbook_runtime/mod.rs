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
//! - FN4-03 — lazy IF/IFERROR (needs scalar.rs Function-branch refactor).
//! - Cross-sheet formula references via NameTable resolution (Phase 4.6).

use ql_functions::format::FormatString;
use ql_functions::FunctionRegistry;
use ql_oplog::OpLog;
use ql_storage::{FormatId, Workbook};
use ql_types::{ColId, RowId, SheetId, MAX_COLUMN, MAX_ROW};

use crate::plan_cache::{PlanCache, PlanCacheStats};

// **Tier D1 (2026-05-18) — Phase 5 prep monolith split.** Sibling
// submodules under `crate::workbook_runtime`. Each adds an
// `impl<'a> WorkbookRuntime<'a>` block extending the same struct
// without changing the public API. Full per-step history with
// commit hashes lives in `docs/PHASE-4-V2-BACKLOG.md` § D1; design
// in `docs/architecture/workbook-runtime-split-design.md`.
mod cells;
mod config;
mod error;
mod formats;
mod names;
mod recompute;
mod sheets;
mod tables;
mod validate;
pub use error::{RecomputeFailure, RecomputeResult, RuntimeError};

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
    pub fn with_session_state(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        oplog: &'a mut OpLog,
        graph: &'a mut crate::CalcgraphSession,
        plan_cache: PlanCache,
    ) -> Self {
        Self {
            workbook,
            registry,
            oplog: Some(oplog),
            plan_cache,
            format_cache: std::collections::HashMap::new(),
            graph: Some(graph),
        }
    }

    /// **Phase 6.1B inc.2 (2026-05-26).** Consume the runtime and return
    /// its (now warmed) `PlanCache` so the owning session can retain it
    /// for the next edit. Pairs with [`with_session_state`].
    ///
    /// [`with_session_state`]: WorkbookRuntime::with_session_state
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
