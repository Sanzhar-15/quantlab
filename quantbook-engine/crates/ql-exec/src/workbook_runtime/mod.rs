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

use std::sync::Arc;

use ql_formula_syntax::{lex, lex_with, parse, print_with, FormulaSite};
use ql_functions::format::FormatString;
use ql_functions::FunctionRegistry;
use ql_io::CellWireValue;
use ql_oplog::{Op, OpLog};
use ql_storage::{FormatId, SpillShape, Workbook};
use ql_types::{ArrayValue, ColId, ErrorValue, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};

use crate::env::WorkbookEnv;
use crate::eval_result::EvalResult;
use crate::plan::{bind_with_site, BindError, BindSite};
use crate::plan_cache::{PlanCache, PlanCacheKey, PlanCacheStats};
use crate::transaction::WorkbookTransaction;

// **Tier D1 (2026-05-18 — Phase 5 prep, monolith split):** sibling
// submodules under `crate::workbook_runtime`. Each submodule adds an
// `impl<'a> WorkbookRuntime<'a> { ... }` block to extend the struct
// without changing its public API surface. See
// `docs/architecture/workbook-runtime-split-design.md`.
//
// Step 1 (2026-05-18, commit 79c1ebeefa7): error/result types →
//   `error.rs`. Re-exported here so callers continue to import
//   `RuntimeError` / `RecomputeFailure` / `RecomputeResult` from
//   `crate::workbook_runtime` unchanged.
// Step 3.1 (2026-05-18): format API (intern_format, set_cell_format,
//   read_display) → `formats.rs`. No public re-export needed (methods
//   stay on `WorkbookRuntime`).
// Step 3.2 (2026-05-18): workbook config setters (set_reference_mode,
//   set_locale) → `config.rs`. As a side effect, the rename_table doc
//   that was previously misattached to set_reference_mode now correctly
//   attaches to pub fn rename_table.
// Step 3.3 (2026-05-18): sheet API (add_sheet, rename_sheet) + the
//   private `rewrite_formula_text_for_sheet_rename` helper → `sheets.rs`.
mod config;
mod error;
mod formats;
mod sheets;
pub use error::{RecomputeFailure, RecomputeResult, RuntimeError};

/// Phase 2A.6 audit H1/L4 (2026-05-12) helper. Confirms `sheet` is in range
/// before any work that would otherwise panic inside `Workbook::put_at`.
/// `pub(crate)` so `WorkbookTransaction` can call the same validator at
/// `put_value` / `put_formula` buffering time.
pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
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

// (Tier D1 Step 1: error/result types moved to error.rs above —
//  see the mod declaration + pub use at the top of this file.)

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

    /// Phase 2B.3: snapshot of cumulative bind-plan-cache observability
    /// since this runtime was constructed. Includes hit count, miss
    /// count, entry count, and convenience hit-rate.
    pub fn cache_stats(&self) -> PlanCacheStats {
        self.plan_cache.stats()
    }

    /// Set a cell to a formula. Pipeline: lex → parse → bind (against `sheet`) →
    /// eval against the current workbook → put_at the result + put_formula the text.
    ///
    /// Returns the evaluated value, or a `RuntimeError` if any pipeline stage fails.
    /// On error, the workbook is unchanged (no partial writes).
    ///
    /// `formula_text` is the formula body without the leading `=`. The Sheet must
    /// already exist.
    pub fn set_formula(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: impl Into<Arc<str>>,
    ) -> Result<Value, RuntimeError> {
        // Phase 2A.7 audit H1 (was 2A.6 L4 sheet-only): validate sheet AND
        // row/col bounds up front. Without these checks, out-of-grid cells
        // sneak past lex/parse/bind and panic inside `Sheet::put` (which
        // asserts `row <= MAX_ROW && col <= MAX_COLUMN`).
        validate_cell(self.workbook, sheet, row, col)?;

        let raw_text = formula_text.into();

        // **W5-147 (Phase 4.9.K):** canonical-storage flow per design §
        // 4.4. Read the workbook's user-facing mode + locale, lex the
        // input under those, parse, then `print_with(.., A1, EnUs,
        // Some(site))` to canonicalize.
        //
        // Outputs:
        // - `canonical_text` is what we store in the op-log + workbook
        //   formula table. Always A1+EnUs, with R1C1 forms resolved to
        //   A1 via the formula's own cell anchor.
        // - `expr` is the parsed AST, fed into bind below.
        //
        // The `parse → print_with` round-trip canonicalizes:
        //   - R1C1Ref → `$E$3` / `A1` (abs flags from AxisSpec).
        //   - `2,5` (DE) → `2.5` (EN).
        //   - `SUM(A1; B2)` (DE) → `SUM(A1, B2)` (EN).
        //   - `@A1` stays `@A1` (implicit intersection is locale + mode
        //     invariant; preserved through canonicalization).
        let mode = self.workbook.reference_mode();
        let locale = self.workbook.locale();
        let addr = ql_types::Address::new(sheet, row, col);
        let site = FormulaSite::at_cell(addr);

        let tokens = lex_with(raw_text.as_ref(), mode, locale)?;
        let expr = parse(tokens)?;
        let canonical_text: Arc<str> = Arc::from(print_with(
            &expr,
            ql_types::ReferenceMode::A1,
            ql_types::Locale::EnUs,
            Some(site),
        )?);
        // **W5-147:** downstream code (put_formula, write_spill, the
        // failure-tracking path that reads `formula_text` by name) all
        // expect a single `formula_text` Arc<str>. Rebind here so the
        // canonical form propagates through unchanged code paths.
        let formula_text: Arc<str> = Arc::clone(&canonical_text);

        // Phase 2B.3: consult the bind-plan cache. **W5-147 update**:
        // the cache key now uses `canonical_text` (not the raw input)
        // so two writes with different RAW text (`A1` vs `R1C1` for
        // the same anchor; `2.5` vs `2,5`) but the same canonical form
        // share a single plan. The NameTable-generation slot still
        // invalidates on name registration.
        //
        // **W5-150 (Phase 4.9.O HIGH-1 closure):** `@`-bearing
        // canonical text narrows AT BIND TIME using the formula's
        // own cell (W5-144). The bound plan is cell-specific, so
        // include the cell anchor in the cache key when `@` is
        // present. Non-`@` formulas keep `cell_anchor: None` so the
        // cache continues to share plans across cells (preserves
        // the SUM(A1:A10)-across-rows fast path).
        let name_gen = self.workbook.names().generation();
        let cell_anchor = if canonical_text.contains('@') {
            Some((row, col))
        } else {
            None
        };
        let cache_key = PlanCacheKey {
            text: Arc::clone(&canonical_text),
            sheet,
            name_gen,
            cell_anchor,
        };
        let plan: Arc<crate::plan::ExprPlan> =
            self.plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    // We already have the parsed `expr` — bind directly.
                    // **W5-114 (Phase 4.8.E):** carry the formula's own cell
                    // address through BindSite; 4.8.F's structured-ref
                    // `[@Col]` resolution reads it.
                    Ok(bind_with_site(
                        &expr,
                        BindSite::at_cell(addr),
                        self.workbook,
                        self.workbook,
                        self.workbook,
                    )?)
                })?;

        // **Phase 2A.3.b op-log emission, BEFORE any storage mutation.**
        // The contract on this method ("On error, the workbook is unchanged")
        // requires that op-log append fail BEFORE we touch workbook state.
        // We emit `PutFormula` only — the evaluated value isn't recorded
        // because replay re-derives it via `WorkbookRuntime::recompute_all`
        // (see replay.rs module docs).
        //
        // **W5-103 megaudit HIGH-3 closure** (Codex pass-2 finding): pre-4.7.J
        // ordering had this append BEFORE mutation. The 4.7.J.5 +
        // 4.7.J.2 clear_spill calls were inserted between bind and append,
        // which broke atomicity — a failing append would leave the host
        // spill / old self-spill already dissolved. Restored ordering:
        // bind → append → (only then) clear_spill mutations.
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::PutFormula {
                sheet,
                row,
                col,
                // **W5-147 (Phase 4.9.K):** persist CANONICAL (A1+EnUs)
                // text per design § 4.4. Replay against a fresh
                // workbook re-applies the canonical text regardless
                // of the original user-typed mode / locale.
                text: canonical_text.as_ref().to_owned(),
            })?;
        }

        // **W5-103 (Phase 4.7.J.5 / Codex W5-102 MEDIUM-3):** if the
        // target cell is currently a non-anchor cell of someone else's
        // spill, dissolve THAT spill first. Per design § 10.2 (user
        // write into spill target): typing into a spilled cell breaks
        // the host spill — the host's anchor formula stays put, but
        // re-eval at the host (next recompute) will see this cell as
        // a blocker and emit #SPILL!.
        //
        // **W5-103 megaudit HIGH-1 closure (#127, all 3 reviewers
        // cross-confirmed):** capture the host's footprint BEFORE
        // clearing it so the on_set_value + re-extract passes below
        // can also walk the host's old footprint. Without this:
        //   - Readers of OTHER host-target cells (siblings of the
        //     edited cell) don't dirty.
        //   - Readers producer-aliased to the host anchor stay
        //     stale (their alias dep should re-route post-dissolution).
        //   - The host anchor's formula node is NEVER marked dirty,
        //     so recompute_dirty leaves it indefinitely stale. The
        //     storage layer (no spill) and dirty set (anchor not
        //     dirty) diverge until an unrelated edit touches the
        //     anchor cell. Sonnet's sharp framing in the megaudit.
        //
        // We perform this dissolution UP FRONT (before the
        // self-spill clear below) because:
        //   - The host spill's anchor is at a DIFFERENT cell, so its
        //     footprint isn't covered by `clear_spill_if_present` below.
        //   - The new formula at (sheet, row, col) needs the host's
        //     prior computed-overlay value cleared from this cell so
        //     `write_spill`'s blocking check doesn't see it as occupied.
        //
        // Records (host_anchor, host_shape) when dissolution happens;
        // the on_set_value + re-extract passes consume this below.
        let dissolved_host: Option<((SheetId, RowId, ColId), SpillShape)> = {
            if let Some(host_anchor) = self.workbook.spill_target_anchor(sheet, row, col) {
                if host_anchor != (sheet, row, col) {
                    let host_shape = self
                        .workbook
                        .spill_anchor_at(host_anchor.0, host_anchor.1, host_anchor.2)
                        .copied()
                        .expect(
                            "spill_target_anchor returned Some — anchor MUST be in anchors table",
                        );
                    // Idempotent — `clear_spill_at` errors with
                    // SpillNotFoundError if the anchor isn't registered,
                    // which can't happen here (target_anchor returned Some).
                    let _ = self.workbook.clear_spill_at(host_anchor);
                    Some((host_anchor, host_shape))
                } else {
                    None
                }
            } else {
                None
            }
        };

        // **W5-103 (Phase 4.7.J.2 / Codex W5-102 MEDIUM-4):** clear any
        // PRIOR spill anchored at this cell BEFORE eval. Per design § 8.3:
        // every re-eval at an anchor cell starts by dissolving the old
        // footprint, EVEN IF the new result will block. Without this,
        // a 3-row spill shrinking to 1 row would leave the old A2/A3
        // computed entries in place; or a re-eval that blocks would
        // self-block against its own old footprint.
        //
        // `clear_spill_if_present` is a no-op when no spill exists.
        //
        // **W5-103 (Phase 4.7.J.3 / Codex W5-102 MEDIUM-1):** capture
        // the OLD footprint BEFORE we clear it so the calcgraph hook
        // pass below can fire `on_set_value` for each cell that lost
        // its previous spilled value. Otherwise pre-existing readers
        // indexed under target cells (HIGH-1 problem) won't see that
        // their dep cell is now Blank.
        let old_spill_shape = self.workbook.spill_anchor_at(sheet, row, col).copied();
        self.workbook.clear_spill_if_present((sheet, row, col));

        // Evaluate at the cell boundary. Returns `EvalResult::Scalar`
        // for every plan whose outermost node is non-Array; returns
        // `EvalResult::Array` for top-level `ExprPlan::Array(_)` (and,
        // later, array-returning functions — Phase 4.7.M/N).
        //
        // Phase 3.6 (W5-39): when a session is attached, route through
        // `eval_scalar_with_cache` (inside `eval_at_cell_boundary`) so
        // aggregate-range results land in the session's cache.
        let result: EvalResult = {
            // **W5-117 (Phase 4.8.G.2):** carry the formula's cell for
            // structured-ref `[@Col]` row narrowing at eval time.
            let env = WorkbookEnv::with_formula_cell(
                self.workbook,
                ql_types::Address::new(sheet, row, col),
            );
            match self.graph.as_deref() {
                Some(session) => crate::scalar::eval_at_cell_boundary(
                    plan.as_ref(),
                    &env,
                    self.registry,
                    session.aggregate_cache(),
                ),
                None => {
                    // No session attached: synthesize a no-op cache.
                    // The legacy `eval_scalar_with_registry` did the
                    // equivalent through `NoAggregateCache`; we do the
                    // same here for cell-boundary parity.
                    let nc = crate::aggregate_cache::NoAggregateCache;
                    crate::scalar::eval_at_cell_boundary(plan.as_ref(), &env, self.registry, &nc)
                }
            }
        };

        // **Route by EvalResult variant.** Scalar takes the existing
        // single-cell write path; Array routes to spill writeback.
        // The Array path also returns the SHAPE of the spill on the
        // happy path (None on degenerate/bounds/blocked outcomes) so
        // the calcgraph hook pass below can fire `on_set_value` at
        // each target cell.
        let (anchor_value, new_spill_shape) = match result {
            EvalResult::Scalar(v) => {
                // Existing scalar persistence path. Phase 3.5 (CORR-25):
                // a formula's output goes to the COMPUTED overlay, not
                // the user overlay; clear any stale user-overlay entry
                // first so the user-first read cascade doesn't mask
                // the new output.
                self.workbook.clear_user_at(sheet, row, col);
                self.workbook.put_computed_at(sheet, row, col, v.clone());
                self.workbook.put_formula(sheet, row, col, formula_text);
                (v, None)
            }
            EvalResult::Array(array) => self.write_spill(sheet, row, col, array, formula_text),
        };

        // Phase 3.1: notify calcgraph after the workbook mutation
        // succeeds. Phase 3.2 (2026-05-12): pass the already-bound
        // `ExprPlan` straight from the PlanCache so the hook walks it
        // for cell/range/name + volatile deps without re-binding. The
        // plan is shared by Arc; the hook only needs `&ExprPlan`.
        // **W5-102 (Phase 4.7.I):** also pass `&Workbook` so the dep
        // extractor can rewrite spill-target CellRefs to point at the
        // anchor's formula node (producer-alias model, design § 10.1).
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_set_formula(sheet, row, col, plan.as_ref(), self.workbook);
        }

        // **W5-103 (Phase 4.7.J.3 / Codex W5-102 MEDIUM-1):** fire
        // `on_set_value` at every NON-ANCHOR cell in:
        //   - OLD self-spill footprint (anchored at this cell)
        //   - NEW spill footprint (anchored at this cell)
        //   - DISSOLVED HOST footprint (anchored elsewhere — only
        //     present when J.5 dissolution fired). megaudit HIGH-1.
        //
        // Anchor cells are NOT in `affected` for the self-anchored
        // shapes — `on_set_formula(sheet, row, col)` above already
        // dirtied this cell. For the host spill, we DO include the
        // host anchor (its formula node needs to dirty so the next
        // recompute re-evaluates the host and emits #SPILL!).
        //
        // Why each footprint?
        //
        // - NEW (self): range-stripe deps over a target need to dirty
        //   when the anchor recomputes. Producer-alias rewrite (4.7.I)
        //   only handles `deps.cells`; range deps go through the
        //   stripe index keyed at target address. Firing on_set_value
        //   at each target dirties stripe dependents.
        //
        // - OLD (self): readers indexed under old target cells (4.7.I
        //   HIGH-1) wouldn't see their dep cell go Blank otherwise.
        //
        // - HOST (dissolved by J.5): readers of OTHER host-target
        //   cells need to dirty (their dep cell lost the spilled
        //   value). The host anchor cell ITSELF needs to dirty so
        //   the next recompute_dirty re-evaluates the host formula
        //   and produces #SPILL! per design § 9.2.
        //
        // Dedupe via HashSet.
        if let Some(g) = self.graph.as_deref_mut() {
            use std::collections::HashSet;
            let mut affected: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
            // Self-anchored shapes (old + new), excluding self-anchor.
            for shape in [old_spill_shape, new_spill_shape].into_iter().flatten() {
                for dr in 0..shape.rows {
                    for dc in 0..shape.cols {
                        if dr == 0 && dc == 0 {
                            continue;
                        }
                        affected.insert((sheet, row + dr, col + dc));
                    }
                }
            }
            // Host footprint (if dissolved by J.5). Non-anchor targets
            // get on_set_value; the host anchor gets mark_dirty directly
            // (it's a formula node, not in cell_to_formulas[anchor]
            // for itself).
            if let Some((host_anchor, host_shape)) = dissolved_host {
                for dr in 0..host_shape.rows {
                    for dc in 0..host_shape.cols {
                        // Skip the host anchor — mark_dirty below.
                        if dr == 0 && dc == 0 {
                            continue;
                        }
                        affected.insert((host_anchor.0, host_anchor.1 + dr, host_anchor.2 + dc));
                    }
                }
            }
            for (s, r, c) in affected {
                g.on_set_value(s, r, c);
            }
            // **megaudit HIGH-1 closure**: dirty the host anchor's
            // formula NodeId directly. on_set_value at the anchor cell
            // wouldn't find it (formulas don't reference themselves),
            // so use the public(crate) `mark_dirty` API.
            if let Some((host_anchor, _)) = dissolved_host {
                if let Some(node) = g.cell_node_for(host_anchor.0, host_anchor.1, host_anchor.2) {
                    g.mark_dirty(node);
                }
            }
        }

        // **W5-103 (Phase 4.7.J.4 / Codex W5-102 HIGH-1)** —
        // re-extract deps for any reader whose `cell_to_formulas` index
        // currently points at a cell in the OLD or NEW spill footprint.
        // This is the structural counterpart to the on_set_value pass
        // above: that loop dirties via the EXISTING (possibly stale)
        // index; this loop updates the index + graph edges to reflect
        // the new producer-alias topology.
        //
        // Two cases handled by ONE pass:
        //
        // 1. **New-spill case** (NEW footprint contains pre-existing
        //    readers): a reader B1=A2 was bound BEFORE A1 spilled, so
        //    B1's dep is indexed at (0,1,0) with no graph edge to A1.
        //    After re-extraction with the now-registered spill, the
        //    producer-alias rewrite (4.7.I) routes B1's dep to A1 and
        //    creates the graph edge.
        //
        // 2. **Dissolution case** (OLD footprint contains anchor-aliased
        //    readers): a reader B1=A2 bound AFTER A1 spilled was aliased
        //    to (0,0,0). If A1 now dissolves, B1's stale alias dep at
        //    (0,0,0) would over-dirty B1 on unrelated A1 changes AND
        //    miss future A2 writes (since A2 is no longer a target;
        //    its writes don't reach (0,0,0) via the alias). Re-extracting
        //    with the spill GONE restores B1's dep to (0,1,0) directly.
        //
        // Per design § 10.5 — this is the targeted re-extraction
        // trigger (a refinement of Option a's "invalidate all readers
        // transitively" — we touch only readers in the footprint).
        //
        // **W5-103 megaudit HIGH-1 closure (#127):** the host footprint
        // (dissolved by J.5 at the top of this function) also needs
        // re-extraction. A reader producer-aliased to the HOST anchor
        // (because it referenced any cell in the host's spill) must
        // be re-routed back to a literal CellRef now that the host
        // spill is gone. Without this, the reader's alias dep at the
        // host anchor would over-dirty on unrelated host changes and
        // miss future writes to the cell it actually references.
        //
        // Skip the entire pass if no SELF spill state changed; the
        // host-spill pass is gated separately on `dissolved_host`.
        if old_spill_shape.is_some() || new_spill_shape.is_some() {
            self.reextract_spill_footprint_readers(
                sheet,
                row,
                col,
                old_spill_shape,
                new_spill_shape,
            );
        }
        if let Some((host_anchor, host_shape)) = dissolved_host {
            // Re-extract readers in the dissolved host footprint. The
            // host anchor itself is excluded inside
            // `reextract_spill_footprint_readers` (it's the function's
            // anchor parameter — its own deps aren't touched).
            self.reextract_spill_footprint_readers(
                host_anchor.0,
                host_anchor.1,
                host_anchor.2,
                Some(host_shape),
                None,
            );
        }

        Ok(anchor_value)
    }

    /// **W5-103 (Phase 4.7.J.4 / Codex W5-102 HIGH-1)** — re-extract
    /// deps for every formula whose `cell_to_formulas` index points at
    /// any cell in the UNION of the OLD and NEW spill footprints
    /// anchored at `(sheet, row, col)`. Excludes the anchor cell itself
    /// (its own deps were already (re-)extracted by `on_set_formula`).
    ///
    /// Re-extraction means: re-bind the reader's formula text (via the
    /// PlanCache, so a cached miss is the only cost when the surrounding
    /// `name_gen` is stable) and re-run `extract_and_register_deps`. The
    /// producer-alias rewrite inside `extract_and_register_deps` then
    /// sees the now-current spill table and routes target-cell CellRefs
    /// to the anchor (or unroutes them if the spill dissolved).
    ///
    /// Defensive on bind failure: a reader whose formula text no longer
    /// parses (e.g. it was bound under a different name-gen state) is
    /// skipped. Its broken state surfaces at its own next recompute —
    /// we don't want to fail the surrounding `set_formula` call because
    /// of an unrelated reader.
    fn reextract_spill_footprint_readers(
        &mut self,
        anchor_sheet: SheetId,
        anchor_row: RowId,
        anchor_col: ColId,
        old_shape: Option<SpillShape>,
        new_shape: Option<SpillShape>,
    ) {
        // Step 1: collect reader info under an immutable borrow of the
        // graph. The HashSet dedupes across the old+new union, AND
        // dedupes the anchor cell out (its own deps were handled by
        // on_set_formula above).
        let reader_info: Vec<(ql_calcgraph::NodeId, SheetId, RowId, ColId, Arc<str>)> = {
            let g = match self.graph.as_deref() {
                Some(g) => g,
                None => return, // No graph attached — nothing to re-extract.
            };
            use std::collections::HashSet;
            let mut seen: HashSet<ql_calcgraph::NodeId> = HashSet::new();
            let mut result: Vec<(ql_calcgraph::NodeId, SheetId, RowId, ColId, Arc<str>)> =
                Vec::new();
            for shape in [old_shape, new_shape].into_iter().flatten() {
                for node in
                    g.readers_in_rect(anchor_sheet, anchor_row, anchor_col, shape.rows, shape.cols)
                {
                    if !seen.insert(node) {
                        continue;
                    }
                    // Skip the anchor — its own deps were just (re-)bound
                    // by on_set_formula. Resolve address + formula text
                    // in a single pass.
                    let Some((s, r, c)) = g.cell_address_for(node) else {
                        continue;
                    };
                    if (s, r, c) == (anchor_sheet, anchor_row, anchor_col) {
                        continue;
                    }
                    // A reader without a formula text means
                    // cell_to_formulas has a stale entry — defensive skip.
                    let Some(text) = self.workbook.formula_at(s, r, c).cloned() else {
                        continue;
                    };
                    result.push((node, s, r, c, text));
                }
            }
            result
        };

        // Step 2: re-bind + re-extract for each reader. The borrow of
        // `g` from step 1 is released; we now alternate immutable workbook
        // reads (inside the PlanCache miss closure) with mutable graph
        // mutations (reextract_deps).
        for (node, reader_sheet, reader_row, reader_col, text) in reader_info {
            let name_gen = self.workbook.names().generation();
            // **W5-150 (Phase 4.9.O HIGH-1):** cell-aware key when `@`
            // is present (see set_formula for rationale).
            let cell_anchor = if text.contains('@') {
                Some((reader_row, reader_col))
            } else {
                None
            };
            let cache_key = PlanCacheKey {
                text: Arc::clone(&text),
                sheet: reader_sheet,
                name_gen,
                cell_anchor,
            };
            let plan: Arc<crate::plan::ExprPlan> = match self
                .plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    let tokens = lex(text.as_ref())?;
                    let expr = parse(tokens)?;
                    // **W5-114 (Phase 4.8.E):** carry reader cell address.
                    Ok(bind_with_site(
                        &expr,
                        BindSite::at_cell(ql_types::Address::new(
                            reader_sheet,
                            reader_row,
                            reader_col,
                        )),
                        self.workbook,
                        self.workbook,
                        self.workbook,
                    )?)
                }) {
                Ok(p) => p,
                Err(_e) => {
                    // **Codex audit pass-1 MEDIUM-2 closure (#129):**
                    // the reader's formula no longer binds (workbook
                    // state shifted in a way that broke its plan —
                    // e.g. a referenced name was removed). Per
                    // CLAUDE.md no-fallbacks, silently `continue` is
                    // not acceptable — that preserves stale
                    // `cell_to_formulas` + graph-edge state and the
                    // failure becomes invisible to the user.
                    //
                    // We can't bubble up: the user's set_formula on
                    // the ANCHOR succeeded; failing it because some
                    // UNRELATED reader's bind broke would be punitive.
                    //
                    // Compromise: mark the reader's NodeId dirty so
                    // the next recompute re-attempts evaluation. The
                    // recompute path will produce a visible error at
                    // the reader's cell. The stale graph state for
                    // this reader survives until then — accepted as
                    // a known limitation; a full fix needs a
                    // structured diagnostics channel (deferred).
                    if let Some(g) = self.graph.as_deref_mut() {
                        g.mark_dirty(node);
                    }
                    continue;
                }
            };
            if let Some(g) = self.graph.as_deref_mut() {
                g.reextract_deps(node, plan.as_ref(), self.workbook);
                // **megaudit HIGH-1 closure (#127)**: dirty the
                // re-extracted reader. on_set_value at the OLD/NEW
                // footprint addresses (fired before this loop) used
                // the PRE-rewrite cell_to_formulas index. After
                // reextract_deps moves the reader's index entry, a
                // reader that USED to be at an old address but NOW
                // points to a different address would not have been
                // dirtied by the earlier on_set_value pass (its old
                // index entry was empty by the time the new index
                // landed). Marking the reader dirty here ensures the
                // next recompute_dirty re-evaluates it against the
                // post-dissolution / post-reshape workbook state.
                g.mark_dirty(node);
            }
        }
    }

    /// **W5-103 (Phase 4.7.J.2 / 4.7.J.3)** — spill writeback path.
    /// Called from `set_formula` when `eval_at_cell_boundary` returns
    /// `EvalResult::Array`. Performs (per design § 8.1):
    ///
    /// 1. Degenerate check (`rows == 0 || cols == 0` → `#CALC!`).
    /// 2. Bounds check (anchor + shape fits within grid → `#SPILL!`).
    /// 3. Blocking check (any non-anchor target cell occupied → `#SPILL!`).
    /// 4. Happy path: `register_spill` then `put_computed_at` for every
    ///    cell in the rectangle.
    ///
    /// Anchor cell ALWAYS gets a formula association (`put_formula`).
    /// Non-anchor targets are formula-less per design § 8.2.
    ///
    /// Returns `(anchor_value, Option<SpillShape>)`. `Some(shape)` only
    /// on the happy path (step 4); degenerate/bounds/blocked outcomes
    /// return `None` so the caller knows no new spill footprint exists.
    /// The caller uses the shape to drive Phase 4.7.J.3's target-cell
    /// calcgraph invalidation hook.
    fn write_spill(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        array: ArrayValue,
        formula_text: Arc<str>,
    ) -> (Value, Option<SpillShape>) {
        // **Sheet validation invariant** (megaudit MEDIUM-5 + Codex
        // verify follow-up). `set_formula` validates `sheet < sheet_count()`
        // at entry; single-threaded code with no Drop hooks means the
        // sheet cannot disappear mid-function. Per CLAUDE.md "no
        // fallbacks — errors must be visible," check the invariant
        // ONCE at the top of `write_spill` so it fires uniformly even
        // for 1×1 spills (which skip the per-target blocking loop) or
        // bounds/degenerate exits (which would otherwise miss the
        // check). The bound is unused on the degenerate path but
        // present even there so a future code change can't accidentally
        // bypass the assertion.
        let _sheet_invariant = self
            .workbook
            .sheet(sheet)
            .expect("write_spill: sheet validated at set_formula entry");

        // Degenerate-array origin is a function-eval contract (e.g.
        // FILTER with all-false mask without if_empty). Surface as
        // #CALC!, NOT #SPILL!. Design § 8.1 step c.
        if array.is_degenerate() {
            return self.write_anchor_error(sheet, row, col, ErrorValue::Calc, formula_text);
        }

        // Bounds check. `array.rows() / cols()` are `>= 1` (degenerate
        // path above caught zero). The last cell sits at
        // `(row + rows - 1, col + cols - 1)` — both must satisfy
        // `<= MAX_ROW / MAX_COLUMN`.
        let last_row_offset = array.rows() - 1;
        let last_col_offset = array.cols() - 1;
        let end_row = row.checked_add(last_row_offset);
        let end_col = col.checked_add(last_col_offset);
        let out_of_bounds =
            !matches!((end_row, end_col), (Some(r), Some(c)) if r <= MAX_ROW && c <= MAX_COLUMN);
        if out_of_bounds {
            return self.write_anchor_error(sheet, row, col, ErrorValue::Spill, formula_text);
        }

        // Blocking check. For every NON-ANCHOR cell in the spill
        // rectangle, the cell must be "spill-empty": no formula, no
        // value (user or computed), no other spill anchor. The clear-old
        // step at the top of `set_formula` already removed THIS anchor's
        // prior footprint, so any remaining non-blank computed entry
        // here came from elsewhere.
        for dr in 0..array.rows() {
            for dc in 0..array.cols() {
                if dr == 0 && dc == 0 {
                    continue;
                }
                let r = row + dr;
                let c = col + dc;
                // Sheet existence is asserted at the top of `write_spill`;
                // re-asserting here would be redundant. The `expect` at
                // function entry guarantees this lookup succeeds.
                let sheet_ref = self
                    .workbook
                    .sheet(sheet)
                    .expect("write_spill: sheet asserted at function entry");
                // **Codex audit pass-1 MEDIUM-1 closure (#129):**
                // include `spill_target_anchor` in the predicate so a
                // cell that is a TARGET of another active spill blocks
                // us even when its materialized value happens to be
                // `Value::Blank` (possible once SEQUENCE/FILTER land
                // and an `ArrayValue` carries a Blank slot — the
                // `Sheet::read != Blank` check alone would miss it,
                // letting register_spill panic at a collision later).
                let occupied = self.workbook.spill_anchor_at(sheet, r, c).is_some()
                    || self.workbook.spill_target_anchor(sheet, r, c).is_some()
                    || self.workbook.formula_at(sheet, r, c).is_some()
                    || sheet_ref.read(r, c) != Value::Blank;
                if occupied {
                    return self.write_anchor_error(
                        sheet,
                        row,
                        col,
                        ErrorValue::Spill,
                        formula_text,
                    );
                }
            }
        }

        // Happy path. Register the spill THEN materialize cells.
        // `register_spill` enforces invariants (no anchor collision,
        // no target/anchor footprint overlap with OTHER spills, bounds).
        // The blocking check above proved no value/formula collision.
        let shape = SpillShape::new(array.rows(), array.cols());
        match self.workbook.register_spill((sheet, row, col), shape) {
            Ok(()) => {}
            Err(e) => panic!(
                "W5-103: register_spill failed after blocker check passed — \
                 the blocker check is incomplete or SpillAnchorTable has \
                 a hidden invariant. error: {:?}",
                e
            ),
        }

        // Write each target cell to computed overlay. Anchor gets the
        // (0,0) value; the rest follow row-major order.
        self.workbook.clear_user_at(sheet, row, col);
        for dr in 0..array.rows() {
            for dc in 0..array.cols() {
                let v = array.at(dr, dc).clone();
                self.workbook.put_computed_at(sheet, row + dr, col + dc, v);
            }
        }
        self.workbook.put_formula(sheet, row, col, formula_text);

        // Excel's anchor return value = the (0,0) cell of the array.
        // Callers (formula bar UI, op-log replay) see this.
        (array.at(0, 0).clone(), Some(shape))
    }

    /// **W5-103 megaudit LOW (Codex pass 2 finding):** anchor-error
    /// write helper. The three blocked-spill arms in `write_spill`
    /// (degenerate → `#CALC!`, bounds → `#SPILL!`, blocking →
    /// `#SPILL!`) all do the same five lines: clear user, write error
    /// to computed, persist formula text, return `(err, None)`.
    /// Factor into one helper so a future fix can't update one arm
    /// and miss another.
    fn write_anchor_error(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        error: ErrorValue,
        formula_text: Arc<str>,
    ) -> (Value, Option<SpillShape>) {
        let err = Value::Error(error);
        self.workbook.clear_user_at(sheet, row, col);
        self.workbook.put_computed_at(sheet, row, col, err.clone());
        self.workbook.put_formula(sheet, row, col, formula_text);
        (err, None)
    }

    /// Set a cell to a literal value (no formula). Clears any existing formula
    /// association at the cell — typing a value over a formula cell deletes the
    /// formula per Excel canon. Phase 2A.7 audit H1: validates sheet + row/col
    /// bounds; returns `RuntimeError` instead of panicking on out-of-grid input.
    pub fn set_value(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: Value,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;

        // Phase 2A.3.b: emit ops BEFORE mutating, so a serialization failure
        // (NaN/Inf) leaves the workbook unchanged. `CellWireValue::from_value`
        // returns None for `Value::Blank`; we skip the `PutValue` in that case
        // (documented limitation — replaying a Blank write won't reset a
        // prior non-Blank value; rare enough that the wire-format expansion
        // is deferred to Phase 5+). The `ClearFormula` still fires below if
        // the cell had a formula, so the produced log captures the formula
        // removal even when the literal value is Blank.
        //
        // Phase 2B.7 audit H2 (2026-05-12): when BOTH PutValue and
        // ClearFormula need to land, wrap them in a single `Op::BatchCommit`
        // so the pair is atomic at the Loro level — partial-pair failure
        // (first appended, second fails) is now impossible.
        let had_formula = self.workbook.formula_at(sheet, row, col).is_some();
        if let Some(oplog) = self.oplog.as_deref_mut() {
            let mut log_ops: Vec<Op> = Vec::with_capacity(2);
            if let Some(wire) = CellWireValue::from_value(&value) {
                log_ops.push(Op::PutValue {
                    sheet,
                    row,
                    col,
                    value: wire,
                });
            }
            if had_formula {
                log_ops.push(Op::ClearFormula { sheet, row, col });
            }
            match log_ops.len() {
                0 => {} // Blank value on a non-formula cell — no-op.
                1 => oplog.append(log_ops.into_iter().next().unwrap())?,
                _ => oplog.append(Op::BatchCommit { ops: log_ops })?,
            }
        }

        // **W5-104 (Phase 4.7.K): spill-aware set_value via
        // immediate-dissolve.** Mirrors set_formula's 4.7.J.5 path.
        // Per design § 10.2 (updated to document both immediate and
        // deferred algorithms — we ship immediate for consistency
        // with set_formula).
        //
        // Two spill-relevant scenarios:
        //
        // a) This cell is a TARGET of someone else's spill: dissolve
        //    that host spill so its anchor re-emits #SPILL! next
        //    recompute and the new user value isn't shadowed by the
        //    host's prior computed-overlay write.
        //
        // b) This cell is itself a SPILL ANCHOR (had a formula like
        //    `={1,2,3}`): dissolve its own spill so the targets become
        //    Blank when the new literal lands at the anchor.
        //
        // The host-vs-self distinction matters because `clear_spill_at`
        // is anchor-keyed: case (a) needs `clear_spill_at(host_anchor)`,
        // case (b) needs `clear_spill_at((sheet, row, col))`. Both can
        // happen for the same write only if (sheet, row, col) is both
        // an anchor of its own spill and a target of another — which
        // `SpillAnchorTable::register` prevents (no overlapping
        // rectangles).
        let dissolved_host: Option<((SheetId, RowId, ColId), SpillShape)> = {
            if let Some(host_anchor) = self.workbook.spill_target_anchor(sheet, row, col) {
                if host_anchor != (sheet, row, col) {
                    let host_shape = self
                        .workbook
                        .spill_anchor_at(host_anchor.0, host_anchor.1, host_anchor.2)
                        .copied()
                        .expect(
                            "spill_target_anchor returned Some — anchor MUST be in anchors table",
                        );
                    let _ = self.workbook.clear_spill_at(host_anchor);
                    Some((host_anchor, host_shape))
                } else {
                    None
                }
            } else {
                None
            }
        };
        // Case (b): self-anchored spill — dissolve before write.
        // Captures the OLD shape so the calcgraph hook pass can fire
        // on_set_value at the dissolved footprint (mirrors 4.7.J.3).
        let dissolved_self_shape = self.workbook.spill_anchor_at(sheet, row, col).copied();
        if dissolved_self_shape.is_some() {
            let _ = self.workbook.clear_spill_at((sheet, row, col));
        }

        self.workbook.put_at(sheet, row, col, value);
        self.workbook.clear_formula(sheet, row, col);

        // Phase 3.1: notify calcgraph. `set_value` always fires
        // `on_set_value`; if the cell had a formula that we just cleared,
        // also fires `on_clear_formula` so the graph can detach old deps
        // when Phase 3.3 wires that path.
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_set_value(sheet, row, col);
            if had_formula {
                g.on_clear_formula(sheet, row, col);
            }
        }

        // **W5-104**: dirty-propagation + re-extraction for dissolved
        // spill footprints. Mirrors set_formula's 4.7.J.3 + 4.7.J.4
        // patterns. Skip the entire pass if no spill state changed.
        let any_dissolution = dissolved_host.is_some() || dissolved_self_shape.is_some();
        if any_dissolution {
            // Hook pass: fire on_set_value at each non-anchor cell in
            // the dissolved footprint(s), plus mark_dirty for the host
            // anchor (since its NodeId isn't in cell_to_formulas for
            // itself).
            if let Some(g) = self.graph.as_deref_mut() {
                use std::collections::HashSet;
                let mut affected: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
                // Self-anchored dissolution: non-anchor cells get dirtied.
                if let Some(shape) = dissolved_self_shape {
                    for dr in 0..shape.rows {
                        for dc in 0..shape.cols {
                            if dr == 0 && dc == 0 {
                                continue;
                            }
                            affected.insert((sheet, row + dr, col + dc));
                        }
                    }
                }
                // Host-anchored dissolution: non-anchor cells get
                // dirtied (host anchor handled via mark_dirty below).
                // The edited cell itself is ALWAYS in the host footprint
                // (it's why we're here); on_set_value above already
                // dirtied it, so skip duplicate add.
                if let Some((host_anchor, host_shape)) = dissolved_host {
                    for dr in 0..host_shape.rows {
                        for dc in 0..host_shape.cols {
                            if dr == 0 && dc == 0 {
                                continue; // host anchor — mark_dirty below
                            }
                            let cell = (host_anchor.0, host_anchor.1 + dr, host_anchor.2 + dc);
                            if cell == (sheet, row, col) {
                                continue; // already dirtied via on_set_value above
                            }
                            affected.insert(cell);
                        }
                    }
                }
                for (s, r, c) in affected {
                    g.on_set_value(s, r, c);
                }
                // Host anchor's formula node: mark dirty directly so
                // recompute_dirty re-evaluates and emits #SPILL!.
                if let Some((host_anchor, _)) = dissolved_host {
                    if let Some(node) = g.cell_node_for(host_anchor.0, host_anchor.1, host_anchor.2)
                    {
                        g.mark_dirty(node);
                    }
                }
            }
            // Re-extract readers in dissolved footprints so producer-
            // alias deps re-route back to literal cell addresses.
            if let Some(shape) = dissolved_self_shape {
                self.reextract_spill_footprint_readers(sheet, row, col, Some(shape), None);
            }
            if let Some((host_anchor, host_shape)) = dissolved_host {
                self.reextract_spill_footprint_readers(
                    host_anchor.0,
                    host_anchor.1,
                    host_anchor.2,
                    Some(host_shape),
                    None,
                );
            }
        }

        Ok(())
    }

    /// Phase 2B.5 (2026-05-12): register a defined name through the runtime,
    /// emitting `Op::SetName` into the attached op log (if any). This is the
    /// op-log-recording wrapper for `Workbook::set_name`; product code SHOULD
    /// route through here so the mutation lands in the op log.
    ///
    /// Direct callers of `Workbook::set_name` bypass the op log silently —
    /// that path is documented as low-level and intended only for tests, the
    /// qbook loader (where the workbook is being constructed from disk and
    /// op-log history is loaded separately), and other engine-internal
    /// reconstruction code. See GAP-O-01 in `docs/known-gaps.md`.
    pub fn set_name(
        &mut self,
        name: &str,
        target: ql_storage::NamedTarget,
    ) -> Result<(), RuntimeError> {
        // Phase 2B.7 audit H3 (was 2B.5 mutate-first): validate → append →
        // mutate so neither failure mode leaves engine state divergent:
        //
        //   1. Reserved-name rejection: caught by `NameTable::would_accept`
        //      before anything else runs. Workbook unmodified, log unmodified.
        //   2. Op-log append failure: caught BEFORE the workbook mutation.
        //      Workbook still unmodified, log unmodified.
        //
        // The prior mutate-first ordering left a divergence window where
        // the workbook had the name but the log didn't — see audit H3 for
        // why that was wrong. The append-first ordering used by set_value /
        // set_formula / clear_formula / add_sheet now extends here.
        //
        // Wire-form encoding canonicalizes the name to upper case to match
        // `NameTable::set`'s on-write canonicalization, so the recorded
        // form is stable regardless of how the caller cased the name.
        self.workbook.names().would_accept(name)?;
        if let Some(oplog) = self.oplog.as_deref_mut() {
            let target_wire = ql_io::NamedTargetWire::from_target(&target);
            oplog.append(Op::SetName {
                scope: None,
                name: name.to_ascii_uppercase(),
                target: target_wire,
            })?;
        }
        // Now the mutation cannot fail (reserved-name already pre-checked).
        // `set_name` returns Result for forward-compat with future
        // NameTableError variants; expect them to be pre-checkable via
        // `would_accept`.
        self.workbook.set_name(name, target)?;

        // Phase 3.1: notify calcgraph. Today a counter-bump; Phase 3.3
        // will mark all formulas containing this name dirty.
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_set_name(name);
        }

        Ok(())
    }

    /// **W5-92 (Phase 4.6.D):** register a sheet-scoped defined name
    /// through the runtime, emitting `Op::SetName { scope: Some(sheet), .. }`
    /// into the attached op log (if any). Sheet-scoped names shadow
    /// workbook-scoped names with the same identifier when accessed
    /// from a formula on `sheet`, per Excel canon (XS-4-03).
    ///
    /// Validation matches `set_name`:
    /// - `Workbook::sheet(sheet)` must exist; otherwise
    ///   `RuntimeError::InvalidSheet`.
    /// - Reserved-name guard fires (currently `AI` per CORR-06); the
    ///   reserved set is workbook-global, so sheet-scoped names are
    ///   refused with the same rule.
    /// - Op-log append failure fails BEFORE the workbook mutation so
    ///   neither failure mode leaves engine state divergent.
    pub fn set_sheet_scoped_name(
        &mut self,
        sheet: SheetId,
        name: &str,
        target: ql_storage::NamedTarget,
    ) -> Result<(), RuntimeError> {
        // 1. Validate sheet id exists.
        let sheet_count = self.workbook.sheet_count();
        if self.workbook.sheet(sheet).is_none() {
            return Err(RuntimeError::InvalidSheet { sheet, sheet_count });
        }
        // 2. Pre-check reserved-name guard so a rejection doesn't
        //    leave a phantom op-log entry. We use the workbook's
        //    `NameTable::would_accept` since the reserved-name set
        //    is workbook-global (per is_reserved_name in storage).
        self.workbook.names().would_accept(name)?;
        // 3. Append op-log entry BEFORE mutation.
        if let Some(oplog) = self.oplog.as_deref_mut() {
            let target_wire = ql_io::NamedTargetWire::from_target(&target);
            oplog.append(Op::SetName {
                scope: Some(sheet),
                name: name.to_ascii_uppercase(),
                target: target_wire,
            })?;
        }
        // 4. Mutate. validation already passed; `set_scoped_name`
        //    returns Result for forward-compat.
        self.workbook
            .sheet_mut(sheet)
            .expect("sheet existence already validated")
            .set_scoped_name(name, target)?;

        // 5. Calcgraph notification — fan out the same as workbook-
        //    scoped sets. Phase 3.3's name→formula tracking is name-
        //    keyed and doesn't currently distinguish scopes; over-
        //    invalidation is the conservative direction here.
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_set_name(name);
        }

        // 6. **W5-93 (Phase 4.6.E closure):** invalidate the plan cache.
        //    Codex HIGH-2: the cache key currently includes only the
        //    workbook-scoped `NameTable::generation()` — a sheet-scoped
        //    name change wouldn't bump that counter, so cached plans
        //    bound against `=Rate` (resolved to workbook-scoped) would
        //    keep evaluating against the workbook value even after a
        //    sheet-scoped `Rate` was registered. Full flush is acceptable
        //    at edit rate (matches the rename pattern); per-sheet
        //    generation counters are design § 10.5 future polish.
        self.plan_cache.clear();

        Ok(())
    }

    // ===== W5-118 (Phase 4.8.H) — table mutation API =====

    /// **W5-118 (Phase 4.8.H):** register a new workbook-scoped table,
    /// emitting `Op::CreateTable` into the attached op log (if any).
    ///
    /// Validation (op log append is BEFORE storage mutation per the
    /// W5-103 atomicity pattern):
    /// - Sheet exists.
    /// - Footprint fits in the sheet (rows + cols > 0).
    /// - No overlap with any existing table footprint.
    /// - Name is unique against both `TableTable` AND `NameTable`
    ///   (shared namespace per design § 4.3 / § 13 decision #3).
    /// - Column count matches `column_names.len()`.
    /// - Column names are non-empty and unique case-insensitively.
    ///
    /// Each column is assigned a stable id from
    /// `TableTable::allocate_column_id`. Header / totals rows are
    /// metadata-only — this method does NOT write into the header row;
    /// callers can pre-populate cells via `set_value`.
    ///
    /// Direct callers of `Workbook::tables_mut().insert` bypass the op
    /// log silently — that path is documented as low-level (qbook
    /// loader + tests).
    #[allow(clippy::too_many_arguments)]
    pub fn create_table(
        &mut self,
        name: &str,
        sheet: SheetId,
        top_row: RowId,
        top_col: ColId,
        rows: u32,
        cols: u32,
        has_header: bool,
        has_totals: bool,
        column_names: Vec<String>,
    ) -> Result<(), RuntimeError> {
        let canonical = name.to_ascii_uppercase();
        // ----- Validation (all checks BEFORE op-log append) -----
        let sheet_count = self.workbook.sheet_count();
        if self.workbook.sheet(sheet).is_none() {
            return Err(RuntimeError::InvalidSheet { sheet, sheet_count });
        }
        if rows == 0 || cols == 0 {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "table rows and cols must both be > 0",
            });
        }
        // **W5-125 (Phase 4.8.O.1 — Codex HIGH-1):** validate footprint
        // upper bound fits within MAX_ROW / MAX_COLUMN. Closes the gap
        // where `for r in top_row..top_row + rows` either ran beyond
        // the addressable grid or u32-overflowed silently.
        if let Err(reason) =
            ql_storage::TableMetadata::validate_footprint_bounds(top_row, top_col, rows, cols)
        {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason,
            });
        }
        if column_names.len() != cols as usize {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "column_names length does not match cols",
            });
        }
        if column_names.iter().any(|s| s.is_empty()) {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "table column names cannot be empty",
            });
        }
        // Column-name uniqueness (case-insensitive).
        {
            use std::collections::HashSet;
            let mut seen: HashSet<String> = HashSet::new();
            for cn in &column_names {
                if !seen.insert(cn.to_ascii_lowercase()) {
                    return Err(RuntimeError::TableCreateRejected {
                        name: name.to_owned(),
                        reason: "table column names must be unique (case-insensitive)",
                    });
                }
            }
        }
        // Name uniqueness (shared namespace: TableTable + NameTable).
        if self.workbook.tables().lookup(&canonical).is_some() {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "table with this canonical name already exists",
            });
        }
        if self.workbook.names().lookup_ci(&canonical).is_some() {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "defined-name with this canonical name already exists (shared namespace)",
            });
        }
        // Non-overlap + no spill anchor inside the footprint.
        // **W5-124 (Phase 4.8.J.2):** spill-anchor invariant § 4.3 #5 —
        // Excel canon: array formulas can't anchor inside a table.
        // Previously enforced only at `write_spill` time (the write-side
        // check consults `Workbook::table_at(anchor)`); creating a
        // table over an existing anchor was silently allowed, leaving
        // the table claiming a cell whose value is computed-from-spill.
        // Single fused loop avoids walking the proposed footprint twice.
        for r in top_row..top_row + rows {
            for c in top_col..top_col + cols {
                if self.workbook.table_at(sheet, r, c).is_some() {
                    return Err(RuntimeError::TableCreateRejected {
                        name: name.to_owned(),
                        reason: "table footprint overlaps an existing table",
                    });
                }
                if self.workbook.spill_anchor_at(sheet, r, c).is_some() {
                    return Err(RuntimeError::TableCreateRejected {
                        name: name.to_owned(),
                        reason: "table footprint contains a spill anchor",
                    });
                }
            }
        }
        // ----- Op-log append (BEFORE mutation per W5-103 atomicity) -----
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::CreateTable {
                name: canonical.clone(),
                sheet,
                top_row,
                top_col,
                rows,
                cols,
                has_header,
                has_totals,
                column_names: column_names.clone(),
            })?;
        }
        // ----- Mutation -----
        use ql_storage::{TableColumn, TableMetadata};
        let columns: Vec<TableColumn> = column_names
            .iter()
            .map(|cn| TableColumn {
                id: self.workbook.tables_mut().allocate_column_id(),
                name: Arc::from(cn.to_ascii_lowercase().as_str()),
                display: Arc::from(cn.as_str()),
                totals_function: None,
            })
            .collect();
        let meta = TableMetadata {
            name: Arc::from(canonical.as_str()),
            display_name: Arc::from(name),
            sheet,
            top_row,
            top_col,
            rows,
            cols,
            has_header,
            has_totals,
            columns,
        };
        self.workbook
            .tables_mut()
            .insert(Arc::from(canonical.as_str()), meta);
        Ok(())
    }

    /// **W5-118 (Phase 4.8.H):** drop a table's metadata. Cells inside
    /// the table footprint are untouched. Formulas referencing the
    /// dropped table re-bind to `BindError::UnknownTable` on next
    /// recompute. Emits `Op::DropTable` to the attached op log (if any).
    ///
    /// **W5-155 (Phase 4.8.G.3):** also fires the calcgraph's
    /// `on_table_drop` hook (W5-154) so formulas previously
    /// referencing this table get BFS-dirty-fanned. Pre-W5-155 the
    /// drop completed without notifying the calcgraph — formulas
    /// with cached `ExprPlan::StructuredRef` plans would continue
    /// reading the (now-untyped) cell range until something else
    /// invalidated them. Post-W5-155 the hook fires:
    /// 1. `table_to_formulas[name]` enumerates the readers.
    /// 2. Each reader marked dirty + BFS-fanout (W5-91 H2 pattern).
    /// 3. Next recompute re-binds → `BindError::UnknownTable` →
    ///    `Value::Error(#NAME?)` per the existing 4.8.F binder.
    ///
    /// The hook fires AFTER the op-log append (atomic with the
    /// mutation, per W5-103) and BEFORE `tables_mut().remove`
    /// (graph fanout is read-only on workbook state; the order
    /// is irrelevant for correctness but matches the pre-existing
    /// rename/resize convention).
    pub fn drop_table(&mut self, name: &str) -> Result<(), RuntimeError> {
        let canonical = name.to_ascii_uppercase();
        if self.workbook.tables().lookup(&canonical).is_none() {
            return Err(RuntimeError::TableNotFound(name.to_owned()));
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::DropTable {
                name: canonical.clone(),
            })?;
        }
        // **W5-155 (Phase 4.8.G.3):** dirty-fan readers BEFORE
        // removing the metadata. The hook receives the canonical
        // uppercase name; the index is keyed identically so the
        // exact-match path always hits.
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_table_drop(&canonical);
        }
        let _ = self.workbook.tables_mut().remove(&canonical);
        // **W5-156 (Phase 4.8.G.3 — HIGH-1 closure):** invalidate
        // the plan cache. `PlanCacheKey` doesn't include
        // `TableTable::generation()`, so a pre-drop cached plan
        // (`ExprPlan::StructuredRef { resolved: <pre-drop range> }`)
        // would HIT on the next recompute and silently read the
        // old cells — masking the W5-154 hook's dirty fanout and
        // violating the design § 12.4 contract ("re-bind to
        // BindError::UnknownTable → emit #NAME?"). Matches the
        // brute-force pattern in `rename_table` / `rename_column`
        // / `resize_table`. A future polish (table_gen in the
        // cache key) would replace this full flush with targeted
        // invalidation.
        self.plan_cache.clear();
        Ok(())
    }

    /// **W5-119 (Phase 4.8.I):** rename a table. Per design § 12.2 + HIGH-1
    /// closure (Codex pass-1), this REWRITES STORED FORMULA TEXT — Excel
    /// canon: the next bind sees the new name and binds successfully.
    ///
    /// Process:
    /// 1. Validate: source exists; target name available (TableTable +
    ///    NameTable shared namespace); not a no-op (same canonical name).
    /// 2. Op-log append `Op::RenameTable` (before any mutation).
    /// 3. Walk every formula cell; parse the text; rewrite via
    ///    `ast::rewrite_table_ref`; if the AST changed, print it back
    ///    and emit `Op::PutFormula` + update storage.
    /// 4. Re-key the `TableTable` entry from old canonical to new
    ///    canonical; update display_name.
    ///
    /// Returns the number of formula cells whose text was rewritten.
    ///
    /// **Tier D1 Step 3.2 doc-attachment fix:** the doc block above
    /// was previously misattached to `set_reference_mode` because
    /// that fn was inserted between this comment and `rename_table`.
    /// Step 3.2 moved the config setters to `config.rs`, so the doc
    /// now reaches its intended target.
    pub fn rename_table(&mut self, old_name: &str, new_name: &str) -> Result<usize, RuntimeError> {
        let old_canonical = old_name.to_ascii_uppercase();
        let new_canonical = new_name.to_ascii_uppercase();
        if self.workbook.tables().lookup(&old_canonical).is_none() {
            return Err(RuntimeError::TableNotFound(old_name.to_owned()));
        }
        // No-op rename (same canonical) — accept silently without
        // emitting an op so the log stays compact.
        if old_canonical == new_canonical {
            return Ok(0);
        }
        // Target uniqueness.
        if self.workbook.tables().lookup(&new_canonical).is_some() {
            return Err(RuntimeError::TableCreateRejected {
                name: new_name.to_owned(),
                reason: "table with this canonical name already exists (rename target)",
            });
        }
        if self.workbook.names().lookup_ci(&new_canonical).is_some() {
            return Err(RuntimeError::TableCreateRejected {
                name: new_name.to_owned(),
                reason: "defined-name with this canonical name already exists (rename target)",
            });
        }
        // Op-log append BEFORE mutation (W5-103 atomicity). We emit
        // RenameTable + N PutFormula ops; if the log append fails,
        // no workbook state has changed yet.
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::RenameTable {
                old_name: old_canonical.clone(),
                new_name: new_canonical.clone(),
            })?;
        }
        // Walk formula cells and rewrite. Collect first to avoid borrow
        // conflicts (iter holds &workbook; rewrite needs &mut workbook).
        let new_display_arc: Arc<str> = Arc::from(new_name);
        let formulas: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
            .workbook
            .iter_formulas()
            .map(|(s, r, c, text)| (s, r, c, Arc::clone(text)))
            .collect();
        let mut rewritten = 0;
        for (s, r, c, text) in formulas {
            let tokens = match lex(text.as_ref()) {
                Ok(t) => t,
                Err(_) => continue, // malformed → leave alone (rewrite is best-effort)
            };
            let expr = match parse(tokens) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let new_expr =
                ql_formula_syntax::rewrite_table_ref(&expr, &old_canonical, &new_display_arc);
            if new_expr == expr {
                continue; // no StructuredRef references the renamed table
            }
            let new_text = ql_formula_syntax::print(&new_expr);
            // Emit PutFormula so replay reconstructs the rewrite.
            if let Some(oplog) = self.oplog.as_deref_mut() {
                oplog.append(Op::PutFormula {
                    sheet: s,
                    row: r,
                    col: c,
                    text: new_text.clone(),
                })?;
            }
            // Update workbook formula text directly (bypass set_formula
            // to avoid re-running the bind eagerly; the recompute path
            // will re-bind against the new name at next eval).
            self.workbook.put_formula(s, r, c, new_text);
            rewritten += 1;
        }
        // Re-key the TableTable entry.
        let mut meta = self
            .workbook
            .tables_mut()
            .remove(&old_canonical)
            .expect("verified at top");
        let new_canonical_arc: Arc<str> = Arc::from(new_canonical.as_str());
        meta.name = Arc::clone(&new_canonical_arc);
        meta.display_name = Arc::clone(&new_display_arc);
        self.workbook.tables_mut().insert(new_canonical_arc, meta);
        // **W5-157 (Phase 4.8.G.3):** fire the calcgraph hook to
        // re-key `table_to_formulas[OLD] → [NEW]`, substitute the
        // Arc<str> in each reader's `deps.tables` so a future
        // `remove_formula_deps` cleans up correctly, and dirty-fan
        // the readers. Without this, a subsequent `drop_table(NEW)`
        // would miss every formula that previously bound against
        // `OLD` (the index still keys them under the stale name).
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_table_rename(&old_canonical, &new_canonical);
        }
        // Invalidate plan cache by clearing — every formula that
        // referenced the OLD name now has new text, so cache lookups
        // miss anyway; the bare invalidation prevents stale entries.
        self.plan_cache.clear();
        Ok(rewritten)
    }

    /// **W5-121 (Phase 4.8.I.2):** rename a column within an existing
    /// table. Mirrors [`Self::rename_table`] semantics for column refs:
    /// rewrites stored formula text in every cell whose StructuredRef
    /// references the renamed column (Excel canon — the next bind sees
    /// the new name).
    ///
    /// Process:
    /// 1. Validate: table exists; source column exists (case-insensitive);
    ///    target name available within the table; non-empty; not a no-op
    ///    (same lowercase canonical).
    /// 2. Op-log append `Op::RenameColumn` (before any mutation).
    /// 3. Walk every formula cell; parse the text; rewrite via
    ///    `ast::rewrite_column_ref` (scoped to refs matching the
    ///    canonical table name); if the AST changed, print + emit
    ///    `Op::PutFormula` + update storage.
    /// 4. Mutate the matching `TableColumn` entry's lowercase canonical
    ///    `name` and case-preserving `display`; bump TableTable
    ///    generation so plan caches invalidate.
    ///
    /// Returns the number of formula cells whose text was rewritten.
    /// Cross-table isolation: structured refs to OTHER tables pass
    /// through unchanged even when they mention a column with the same
    /// name. Same-canonical rename returns `Ok(0)` without emitting an
    /// op (mirrors [`Self::rename_table`]).
    pub fn rename_column(
        &mut self,
        table_name: &str,
        old_col: &str,
        new_col: &str,
    ) -> Result<usize, RuntimeError> {
        let table_canonical = table_name.to_ascii_uppercase();
        // Validate table exists.
        let meta = self
            .workbook
            .tables()
            .lookup(&table_canonical)
            .ok_or_else(|| RuntimeError::TableNotFound(table_name.to_owned()))?;
        // Validate source column exists.
        if meta.lookup_column(old_col).is_none() {
            return Err(RuntimeError::TableColumnNotFound {
                table: table_name.to_owned(),
                column: old_col.to_owned(),
            });
        }
        // Empty target rejected.
        if new_col.is_empty() {
            return Err(RuntimeError::TableColumnRejected {
                table: table_name.to_owned(),
                column: new_col.to_owned(),
                reason: "column name cannot be empty",
            });
        }
        // No-op rename (same lowercase canonical) — accept silently
        // without emitting an op. Mirrors `rename_table`. Display-only
        // case rename is deferred to a future sub-phase.
        let old_lower = old_col.to_ascii_lowercase();
        let new_lower = new_col.to_ascii_lowercase();
        if old_lower == new_lower {
            return Ok(0);
        }
        // Target uniqueness within the table.
        if meta.lookup_column(new_col).is_some() {
            return Err(RuntimeError::TableColumnRejected {
                table: table_name.to_owned(),
                column: new_col.to_owned(),
                reason: "column with this canonical name already exists (rename target)",
            });
        }
        // Op-log append BEFORE mutation (W5-103 atomicity). RenameColumn
        // + N PutFormula ops; if the log append fails, no workbook state
        // has changed yet.
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::RenameColumn {
                table: table_canonical.clone(),
                old_name: old_col.to_owned(),
                new_name: new_col.to_owned(),
            })?;
        }
        // Walk formula cells and rewrite. Collect first to avoid borrow
        // conflicts (iter holds &workbook; rewrite needs &mut workbook).
        let new_display_arc: Arc<str> = Arc::from(new_col);
        let formulas: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
            .workbook
            .iter_formulas()
            .map(|(s, r, c, text)| (s, r, c, Arc::clone(text)))
            .collect();
        let mut rewritten = 0;
        for (s, r, c, text) in formulas {
            let tokens = match lex(text.as_ref()) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let expr = match parse(tokens) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let new_expr = ql_formula_syntax::rewrite_column_ref(
                &expr,
                &table_canonical,
                old_col,
                &new_display_arc,
            );
            if new_expr == expr {
                continue;
            }
            let new_text = ql_formula_syntax::print(&new_expr);
            if let Some(oplog) = self.oplog.as_deref_mut() {
                oplog.append(Op::PutFormula {
                    sheet: s,
                    row: r,
                    col: c,
                    text: new_text.clone(),
                })?;
            }
            self.workbook.put_formula(s, r, c, new_text);
            rewritten += 1;
        }
        // Mutate the column metadata in place.
        let meta = self
            .workbook
            .tables_mut()
            .get_mut(&table_canonical)
            .expect("verified at top");
        let (col_idx, _) = meta
            .lookup_column(old_col)
            .expect("verified at top before any mutation");
        meta.columns[col_idx as usize].name = Arc::from(new_lower.as_str());
        meta.columns[col_idx as usize].display = Arc::clone(&new_display_arc);
        // `get_mut` doesn't bump generation; do it explicitly so plan
        // caches keyed on `TableTable::generation` invalidate.
        self.workbook.tables_mut().bump_generation();
        // **W5-158 (Phase 4.8.G.3):** fire the calcgraph hook so the
        // dirty set picks up every reader of this table. Coarse —
        // table-keyed rather than column-keyed (the reverse index
        // doesn't track columns). VEQ at recompute time suppresses
        // the typical no-op writes; the hook's value is keeping
        // the post-rename plan cache + dirty state machine
        // consistent for downstream tooling (debug, ql-profile).
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_column_rename(&table_canonical, old_col, new_col);
        }
        // Invalidate plan cache by clearing — every formula that
        // referenced the OLD column now has new text, so cache lookups
        // miss anyway; bare invalidation prevents stale entries.
        self.plan_cache.clear();
        Ok(rewritten)
    }

    /// **W5-122 (Phase 4.8.J):** resize a table's footprint per
    /// design § 12.3. Three scenarios are supported by a single op:
    ///
    /// - **Grow / shrink rows:** common path. Pass `added_columns =
    ///   removed_columns = []` and the new row count.
    /// - **Append column(s) at the END:** list each new display name
    ///   in `added_columns`; column ids are freshly allocated.
    /// - **Truncate trailing column(s):** list each in
    ///   `removed_columns` in their current left-to-right order
    ///   (case-insensitive on display).
    ///
    /// Inserting / removing a column in the MIDDLE is NOT supported in
    /// 4.8 (Phase 5 structural edits — requires physical cell move).
    ///
    /// Validation (all BEFORE op-log append per W5-103 atomicity):
    /// - Table exists.
    /// - `new_rows > 0` AND `new_cols > 0`.
    /// - `removed_columns.len() <= old_cols`.
    /// - Arithmetic: `new_cols == old_cols + added.len() - removed.len()`.
    /// - `removed_columns` exactly match trailing columns (case-insensitive).
    /// - `added_columns`: non-empty entries; final roster has unique
    ///   canonical (lowercase) names.
    /// - New footprint cells outside the OLD footprint don't overlap
    ///   another table.
    ///
    /// NOTE: a spill-anchor check inside the new footprint is
    /// intentionally OMITTED to mirror `create_table`, which doesn't
    /// check either. The runtime invariant § 4.3 #5 is enforced at
    /// `write_spill` time today; closing this uniformly across
    /// create+resize is a separate follow-up.
    ///
    /// No formula-text rewriting: resize doesn't change column NAMES
    /// of surviving columns, so existing references stay valid.
    /// Re-binding picks up the new range/columns on next eval via the
    /// cleared plan cache.
    ///
    /// **W5-159 (Phase 4.8.G.3):** resize bumps `TableTable::generation`,
    /// clears the plan cache, **re-extracts deps for every table reader**
    /// (via [`Self::reextract_table_readers`] so range stripes reflect
    /// the new range — critical: pre-W5-159 a write into the new growth
    /// area silently missed the formula's stripe), and fires the
    /// [`CalcgraphSession::on_table_resize`] hook to BFS-dirty-fan
    /// downstream readers. Downstream evaluation via
    /// [`Self::recompute_dirty`] then refreshes the `COMPUTED` overlay
    /// against the new metadata. With no graph attached, the
    /// `reextract_table_readers` step is a no-op and callers must use
    /// [`Self::recompute_all`] to pick up post-resize changes.
    pub fn resize_table(
        &mut self,
        name: &str,
        new_rows: u32,
        new_cols: u32,
        added_columns: Vec<String>,
        removed_columns: Vec<String>,
    ) -> Result<(), RuntimeError> {
        use ql_storage::TableColumn;
        let canonical = name.to_ascii_uppercase();
        // Snapshot the immutable bits we need to validate.
        let (sheet, top_row, top_col, old_rows, old_cols, old_displays) = {
            let meta = self
                .workbook
                .tables()
                .lookup(&canonical)
                .ok_or_else(|| RuntimeError::TableNotFound(name.to_owned()))?;
            (
                meta.sheet,
                meta.top_row,
                meta.top_col,
                meta.rows,
                meta.cols,
                meta.columns
                    .iter()
                    .map(|c| c.display.as_ref().to_owned())
                    .collect::<Vec<_>>(),
            )
        };
        // **W5-127 (Phase 4.8.O.3 — Codex LOW-1):** exact no-op
        // short-circuit. Mirrors `rename_column`'s same-canonical
        // semantics. Avoids emitting an `Op::ResizeTable`, bumping
        // `TableTable::generation`, and clearing the plan cache when
        // nothing actually changes. The table is known to exist
        // (snapshot above would have errored). All dims match and no
        // columns are being added/removed, so there's nothing to
        // mutate.
        if new_rows == old_rows
            && new_cols == old_cols
            && added_columns.is_empty()
            && removed_columns.is_empty()
        {
            return Ok(());
        }
        if new_rows == 0 || new_cols == 0 {
            return Err(RuntimeError::TableResizeRejected {
                name: name.to_owned(),
                reason: "table rows and cols must both be > 0",
            });
        }
        // **W5-125 (Phase 4.8.O.1 — Codex HIGH-1):** validate footprint
        // upper bound. `top_row` + `top_col` are inherited from the
        // existing TableMetadata (so they were validated at create
        // time), but new_rows / new_cols can extend past the addressable
        // grid; check before the overlap / spill-anchor walk.
        if let Err(reason) = ql_storage::TableMetadata::validate_footprint_bounds(
            top_row, top_col, new_rows, new_cols,
        ) {
            return Err(RuntimeError::TableResizeRejected {
                name: name.to_owned(),
                reason,
            });
        }
        let added_len = added_columns.len() as u32;
        let removed_len = removed_columns.len() as u32;
        if removed_len > old_cols {
            return Err(RuntimeError::TableResizeRejected {
                name: name.to_owned(),
                reason: "removed_columns count exceeds existing column count",
            });
        }
        if new_cols != old_cols + added_len - removed_len {
            return Err(RuntimeError::TableResizeRejected {
                name: name.to_owned(),
                reason: "new_cols does not match old_cols + added - removed",
            });
        }
        // removed_columns must exactly match trailing displays
        // (case-insensitive).
        let trailing_start = (old_cols - removed_len) as usize;
        for (i, expected) in removed_columns.iter().enumerate() {
            let idx = trailing_start + i;
            if !old_displays[idx].eq_ignore_ascii_case(expected) {
                return Err(RuntimeError::TableResizeRejected {
                    name: name.to_owned(),
                    reason: "removed_columns do not match trailing columns",
                });
            }
        }
        if added_columns.iter().any(|s| s.is_empty()) {
            return Err(RuntimeError::TableResizeRejected {
                name: name.to_owned(),
                reason: "added column names cannot be empty",
            });
        }
        // Build the final canonical (lowercase) roster + check
        // uniqueness.
        let mut final_canon: Vec<String> = old_displays
            .iter()
            .take(trailing_start)
            .map(|d| d.to_ascii_lowercase())
            .collect();
        for a in &added_columns {
            final_canon.push(a.to_ascii_lowercase());
        }
        {
            use std::collections::HashSet;
            let mut seen: HashSet<&str> = HashSet::new();
            for cn in &final_canon {
                if !seen.insert(cn.as_str()) {
                    return Err(RuntimeError::TableResizeRejected {
                        name: name.to_owned(),
                        reason: "final column roster has duplicate canonical names",
                    });
                }
            }
        }
        // Footprint-overlap + no-spill-anchor checks: only cells NEWLY
        // claimed need checking (cells in the OLD footprint already
        // belong to this table; create_table verified them at creation
        // time).
        // **W5-124 (Phase 4.8.J.2):** spill-anchor check mirrors
        // create_table's, restricted to newly-claimed cells.
        let old_end_row = top_row + old_rows;
        let old_end_col = top_col + old_cols;
        let new_end_row = top_row + new_rows;
        let new_end_col = top_col + new_cols;
        for r in top_row..new_end_row {
            for c in top_col..new_end_col {
                let inside_old = r < old_end_row && c < old_end_col;
                if inside_old {
                    continue;
                }
                if let Some(other) = self.workbook.table_at(sheet, r, c) {
                    if !other.name.eq_ignore_ascii_case(&canonical) {
                        return Err(RuntimeError::TableResizeRejected {
                            name: name.to_owned(),
                            reason: "new footprint overlaps an existing table",
                        });
                    }
                }
                if self.workbook.spill_anchor_at(sheet, r, c).is_some() {
                    return Err(RuntimeError::TableResizeRejected {
                        name: name.to_owned(),
                        reason: "new footprint contains a spill anchor",
                    });
                }
            }
        }
        // ----- Op-log append (BEFORE mutation per W5-103) -----
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::ResizeTable {
                name: canonical.clone(),
                new_rows,
                new_cols,
                added_columns: added_columns.clone(),
                removed_columns: removed_columns.clone(),
            })?;
        }
        // ----- Mutation -----
        // Allocate new column ids first; mutable borrows on TableTable
        // versus TableMetadata conflict otherwise.
        let new_ids: Vec<u32> = (0..added_columns.len())
            .map(|_| self.workbook.tables_mut().allocate_column_id())
            .collect();
        let meta = self
            .workbook
            .tables_mut()
            .get_mut(&canonical)
            .expect("verified at top");
        meta.rows = new_rows;
        meta.cols = new_cols;
        meta.columns
            .truncate(meta.columns.len() - removed_len as usize);
        for (cn, id) in added_columns.iter().zip(new_ids) {
            meta.columns.push(TableColumn {
                id,
                name: Arc::from(cn.to_ascii_lowercase().as_str()),
                display: Arc::from(cn.as_str()),
                totals_function: None,
            });
        }
        self.workbook.tables_mut().bump_generation();
        // Full plan-cache flush so formulas re-bind against the new
        // range/column roster on next eval. Targeted `table_gen`-keyed
        // invalidation (W5-160) is optional polish; the brute-force
        // clear is correct, just coarser. Dirty propagation is
        // handled below via `reextract_table_readers` + the W5-159
        // `on_table_resize` hook.
        self.plan_cache.clear();
        // **W5-159 (Phase 4.8.G.3):** the resolved range each reader
        // bound against is now stale (rows or cols changed). Re-extract
        // deps for every reader so the calcgraph's range stripes
        // reflect the new range — without this, cell writes inside
        // the NEW range but OUTSIDE the OLD range would silently miss
        // the formula's stripe and never dirty it. Must run BEFORE
        // the hook fires (which dirty-fans via BFS through the
        // freshly-registered stripes).
        self.reextract_table_readers(&canonical);
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_table_resize(&canonical);
        }
        Ok(())
    }

    /// **W5-159 (Phase 4.8.G.3):** re-bind every formula registered
    /// against `table_canonical` and call `reextract_deps` so the
    /// calcgraph's range-stripe state matches the new resolved range.
    /// Used after `resize_table` mutates `TableMetadata.rows`/`.cols`.
    ///
    /// Pattern mirrors `reextract_spill_footprint_readers` (W5-103):
    /// step 1 collects readers under an immutable graph borrow; step 2
    /// re-binds + re-extracts under alternating immutable workbook /
    /// mutable graph borrows. A bind failure (e.g., a column was
    /// removed by the resize) marks the reader dirty so
    /// `recompute_dirty`'s W5-156 bind-error mapping produces `#NAME?`
    /// at the cell.
    fn reextract_table_readers(&mut self, table_canonical: &str) {
        // Step 1: collect (node, sheet, row, col, text) under an
        // immutable borrow of the graph + workbook.
        let reader_info: Vec<(ql_calcgraph::NodeId, SheetId, RowId, ColId, Arc<str>)> = {
            let g = match self.graph.as_deref() {
                Some(g) => g,
                None => return,
            };
            g.dependents_for_table(table_canonical)
                .into_iter()
                .filter_map(|n| {
                    let (s, r, c) = g.cell_address_for(n)?;
                    let text = self.workbook.formula_at(s, r, c).cloned()?;
                    Some((n, s, r, c, text))
                })
                .collect()
        };

        // Step 2: re-bind + re-extract.
        for (node, sheet, row, col, text) in reader_info {
            let name_gen = self.workbook.names().generation();
            let cell_anchor = if text.contains('@') {
                Some((row, col))
            } else {
                None
            };
            let cache_key = PlanCacheKey {
                text: Arc::clone(&text),
                sheet,
                name_gen,
                cell_anchor,
            };
            let plan: Arc<crate::plan::ExprPlan> = match self
                .plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    // W5-147: stored text is canonical A1+EnUs.
                    let tokens = lex_with(
                        text.as_ref(),
                        ql_types::ReferenceMode::A1,
                        ql_types::Locale::EnUs,
                    )?;
                    let expr = parse(tokens)?;
                    Ok(bind_with_site(
                        &expr,
                        BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
                        self.workbook,
                        self.workbook,
                        self.workbook,
                    )?)
                }) {
                Ok(p) => p,
                Err(_) => {
                    // Bind broken by the resize (e.g., column removed).
                    // Mark dirty; recompute_dirty's W5-156 mapping at
                    // workbook_runtime.rs:3266 will produce #NAME?.
                    if let Some(g) = self.graph.as_deref_mut() {
                        g.mark_dirty(node);
                    }
                    continue;
                }
            };
            if let Some(g) = self.graph.as_deref_mut() {
                g.reextract_deps(node, plan.as_ref(), self.workbook);
            }
        }
    }

    // (Tier D1 Step 3.3: add_sheet / rename_sheet moved to
    //  sheets.rs sibling submodule.)

    /// Phase 2B.5 (2026-05-12): clear a cell's formula association through
    /// the runtime, emitting `Op::ClearFormula` into the attached op log (if
    /// any). Idempotent: clearing a cell with no formula is a no-op for the
    /// workbook AND for the op log (no entry emitted) — avoiding spurious
    /// "removed nothing" entries.
    ///
    /// Note: `set_value` already emits `ClearFormula` automatically when it
    /// overwrites a formula cell. This method is for callers that want to
    /// explicitly strip a formula without changing the cell's value.
    ///
    /// Direct callers of `Workbook::clear_formula` bypass the op log
    /// silently. See GAP-O-03 in `docs/known-gaps.md`.
    pub fn clear_formula(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        let had_formula = self.workbook.formula_at(sheet, row, col).is_some();
        if !had_formula {
            // No-op: nothing to record, nothing to mutate.
            return Ok(());
        }

        // **W5-103 megaudit MEDIUM-4 closure / design § 10.3:** if this
        // cell anchors a spill, dissolve the spill BEFORE clearing the
        // formula. Without this, `SpillAnchorTable` keeps dangling
        // anchor + target entries and the target cells' computed
        // overlays survive as orphan values — Sonnet megaudit caught
        // this gap.
        //
        // **W5-103 megaudit MEDIUM-4 follow-up — op-log atomicity:**
        // mirror the HIGH-3 fix for set_formula. clear_spill_at MUST
        // run AFTER op-log append, otherwise a failing append leaves
        // the spill dissolved with no recorded op (workbook/log
        // divergence). We capture the dissolved_shape via a read-only
        // `spill_anchor_at` lookup BEFORE append, and only perform
        // the actual `clear_spill_at` mutation AFTER the op-log
        // commits successfully.
        //
        // Re-extraction of readers indexed under the dissolved
        // footprint shipped in W5-108 (Phase 4.7.O) via the
        // `reextract_spill_footprint_readers` call after the
        // `on_set_value` pass below.
        //
        // **Value preservation semantic for spill anchors:** for a
        // scalar formula, clear_formula moves the computed value to
        // the user lane (Excel canon: "convert formula to literal").
        // For a spill anchor, the anchor's computed value came from
        // the spilled array, not a scalar result — preserving it
        // would mis-model the spill semantic. We detect spill-anchor
        // case here so the op-log emits ONLY ClearFormula (no spurious
        // PutValue with the array.at(0,0) value).
        let dissolved_shape = self.workbook.spill_anchor_at(sheet, row, col).copied();
        let is_spill_anchor = dissolved_shape.is_some();

        // Producer-replay equivalence: `Workbook::clear_formula` only strips
        // the formula text. Phase 3.5 (CORR-25) made it also drop the
        // computed-overlay entry. To preserve the "strip formula, keep
        // value" semantic for SCALAR formulas, we move the current value
        // into the user-overlay BEFORE clearing. For SPILL anchors, the
        // value is part of the spill; we skip preservation.
        //
        // Order matters for scalars: read current_value BEFORE
        // dissolving any state. For spill anchors, current_value is
        // intentionally not preserved.
        //
        // Phase 2B.7 audit H2 (2026-05-12): wrap PutValue + ClearFormula
        // in a single `Op::BatchCommit` for atomicity. The prior
        // two-append sequence could partially succeed and leave the op
        // log without a recoverable replay state.
        let current_value = if is_spill_anchor {
            // Spill anchor: value is part of the spill, not preserved.
            // Emit only ClearFormula in the op log; skip put_at below.
            Value::Blank
        } else {
            self.workbook.read(ql_types::Address::new(sheet, row, col))
        };

        if let Some(oplog) = self.oplog.as_deref_mut() {
            let mut log_ops: Vec<Op> = Vec::with_capacity(2);
            if let Some(wire) = CellWireValue::from_value(&current_value) {
                log_ops.push(Op::PutValue {
                    sheet,
                    row,
                    col,
                    value: wire,
                });
            }
            log_ops.push(Op::ClearFormula { sheet, row, col });
            match log_ops.len() {
                1 => oplog.append(log_ops.into_iter().next().unwrap())?,
                _ => oplog.append(Op::BatchCommit { ops: log_ops })?,
            }
        }

        // Op-log committed. NOW perform storage mutations.
        if is_spill_anchor {
            // `clear_spill_at` returns SpillNotFoundError only if the
            // anchor isn't registered — can't happen here (we just
            // looked it up via `spill_anchor_at` above).
            let _ = self.workbook.clear_spill_at((sheet, row, col));
        }
        // Phase 3.5: preserve the formula's most-recent value as a USER
        // value before clearing. Blank values are skipped — they're the
        // storage default; writing Blank explicitly is a no-op. For
        // spill anchors, current_value is Blank by construction (above),
        // so this is automatically a no-op.
        if !matches!(current_value, Value::Blank) {
            self.workbook.put_at(sheet, row, col, current_value);
        }
        self.workbook.clear_formula(sheet, row, col);

        // Phase 3.1: notify calcgraph. Phase 3.3 will detach the
        // cleared cell's outgoing edges (its old dependencies no
        // longer apply).
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_clear_formula(sheet, row, col);
        }

        // **W5-103 megaudit MEDIUM-4 closure (continued):** if a spill
        // was just dissolved, fire `on_set_value` for each non-anchor
        // cell in the dissolved footprint. Mirrors `set_formula`'s
        // 4.7.J.3 invalidation pattern: target cells lost their
        // spilled value (now Blank), so any reader indexed under a
        // target address must dirty so its next recompute re-reads
        // from the now-Blank target.
        if let Some(shape) = dissolved_shape {
            if let Some(g) = self.graph.as_deref_mut() {
                for dr in 0..shape.rows {
                    for dc in 0..shape.cols {
                        if dr == 0 && dc == 0 {
                            continue;
                        }
                        g.on_set_value(sheet, row + dr, col + dc);
                    }
                }
            }
            // **W5-108 (Phase 4.7.O) — Codex HIGH BLOCKER closure**:
            // re-extract readers indexed under the dissolved footprint
            // so producer-alias deps re-route back to literal cell
            // addresses. Mirrors `set_value`'s parallel call at the
            // dissolved-self path. Without this, a reader `D1=B1`
            // (where B1 was a spill target of cleared anchor A1)
            // keeps a dep on A1 — a future `set_value(B1, 5)` would
            // NOT dirty D1, since D1's graph dep no longer matches B1.
            // The comment at line 1632 marked this as Phase 4.7.K
            // work; 4.7.O closes it.
            self.reextract_spill_footprint_readers(sheet, row, col, Some(shape), None);
        }

        Ok(())
    }

    // (Tier D1 Step 3.1: intern_format / set_cell_format / read_display
    //  moved to formats.rs sibling submodule — see top of this file.)

    /// Begin a multi-cell transaction. The returned `WorkbookTransaction`
    /// borrows the runtime's workbook + registry for its lifetime. Buffer
    /// writes via `put_value`/`put_formula` then call `commit` to apply them
    /// atomically. See `transaction::WorkbookTransaction` for full semantics.
    ///
    /// Phase 2A.3.b (2026-05-12): if the runtime was constructed with
    /// `with_oplog`, the transaction inherits the op-log handle via
    /// `Option::as_deref_mut` (re-borrowed for the transaction's shorter
    /// lifetime). The runtime is borrow-frozen while the transaction is
    /// alive, so a single op log records both individual edits and batched
    /// commits without aliasing.
    pub fn transaction(&mut self) -> WorkbookTransaction<'_> {
        WorkbookTransaction::with_optional_oplog(
            self.workbook,
            self.registry,
            self.oplog.as_deref_mut(),
        )
    }

    /// Re-evaluate every formula in the workbook. Used after `load_workbook` to
    /// refresh stale values (the qbook loader stores formula text + a sentinel
    /// value; this method computes the real value).
    ///
    /// Iteration order is HashMap-arbitrary, so cross-cell dependencies may
    /// evaluate in a non-deterministic order. Engine Phase 3 calcgraph
    /// integration will add topological scheduling for deterministic + correct
    /// dependency resolution (see `docs/MASTER-PLAN.md` Phase 3.4; tracked as
    /// GAP-R-01 in `docs/known-gaps.md`).
    ///
    /// Phase 2B.2 (2026-05-12): signature changed from `Result<usize,
    /// RuntimeError>` to `RecomputeResult` (always returns; no Result
    /// wrapper). The prior shape short-circuited on first failure and
    /// dropped per-cell context; the new shape continues past failures
    /// and aggregates them. See [`RecomputeResult`] for the contract.
    ///
    /// Cells that fail structurally (lex/parse/bind) keep their
    /// pre-recompute values and formula text. Cells that succeed have
    /// their value replaced. Cells whose evaluation produces an Excel-
    /// canon error value (`#DIV/0!`, `#VALUE!`, etc.) are counted as
    /// succeeded — those error values are normal cell contents per
    /// Excel canon, not structural failures.
    /// Phase 2B.7 (2026-05-12) — dry-run formula validation for IDE
    /// on-keystroke diagnostics. Runs the full lex → parse → bind → eval
    /// pipeline against the current workbook state, returns the would-be
    /// evaluated value (or `RuntimeError`), but does NOT:
    ///
    /// - write to the workbook,
    /// - append to the op log,
    /// - pollute the bind-plan cache (this avoids a transient cache entry
    ///   keyed on a formula text the user hasn't actually committed —
    ///   would inflate the cache miss count and waste a `name_gen` slot).
    ///
    /// Use case: the IDE wants to highlight syntax errors as the user types
    /// in the formula bar, without committing the formula until Enter.
    /// Each keystroke can call `validate_formula(sheet, row, col, draft)`
    /// safely — N calls per keystroke add no engine state.
    ///
    /// Closes GAP-I-04 from `docs/known-gaps.md`.
    pub fn validate_formula(
        &self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &str,
    ) -> Result<Value, RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        let tokens = lex(formula_text)?;
        let expr = parse(tokens)?;
        // W5-92 (Phase 4.6.D): pass `&Workbook` for names so the
        // two-tier sheet-then-workbook scope chain fires.
        // **W5-114 (Phase 4.8.E):** carry the (proposed) cell address so
        // structured-ref `[@Col]` validation works.
        let plan = bind_with_site(
            &expr,
            BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
            self.workbook,
            self.workbook,
            self.workbook,
        )?;
        // **W5-117 (Phase 4.8.G.2):** carry cell for `[@Col]` narrowing.
        let env =
            WorkbookEnv::with_formula_cell(self.workbook, ql_types::Address::new(sheet, row, col));
        // **W5-103 megaudit MEDIUM-3 closure (#129):** route through
        // `eval_at_cell_boundary` so a top-level array literal like
        // `{1, 2, 3}` returns the anchor value (array.at(0,0)) instead
        // of `#CALC!` (which is what `eval_scalar_with_registry` would
        // give per the scalar-context contract at scalar.rs:95).
        //
        // Previously the validate path used scalar eval directly, which
        // made the IDE preview inconsistent with `set_formula`'s actual
        // spill behavior. With this change, validate and set_formula
        // produce equivalent anchor-value previews. The IDE doesn't get
        // the SHAPE of the spill from validate; that would need a
        // dedicated `ValidationResult` enum (deferred — see GAP-I-04).
        let nc = crate::aggregate_cache::NoAggregateCache;
        let result = crate::scalar::eval_at_cell_boundary(&plan, &env, self.registry, &nc);
        Ok(match result {
            crate::eval_result::EvalResult::Scalar(v) => v,
            // Anchor cell preview = array.at(0,0). Degenerate arrays
            // surface as `#CALC!` per the existing scalar-context
            // contract (preserved via `into_scalar_for_test`-style
            // logic inlined here to avoid the cfg(test) gate).
            crate::eval_result::EvalResult::Array(a) if a.is_degenerate() => {
                Value::Error(ErrorValue::Calc)
            }
            crate::eval_result::EvalResult::Array(a) => a.at(0, 0).clone(),
        })
    }

    pub fn recompute_all(&mut self) -> RecomputeResult {
        // **Tier C1 (2026-05-18 — Phase 4.12 Opus-B H-2 closure):**
        // cycle detection. `recompute_all` is the no-session-attached
        // fallback used by `.qbook` load + replay. Before this fix,
        // cyclic formulas like `=A1+1` in A1 silently produced
        // wrong values on each call (1, then 2, then 3, …) because
        // HashMap-order evaluation just re-read the prior value.
        //
        // Strategy: build an ephemeral `CalcgraphSession` from the
        // current workbook, mark every formula dirty, run Tarjan
        // SCC via `schedule_dirty`, and write `#CIRC!` for every
        // cell in a cycle BEFORE the HashMap-order eval loop runs.
        // The acyclic remainder evaluates through the existing
        // HashMap-order loop; any cell that reads from a cycled
        // cell sees the freshly-written `#CIRC!` and propagates it
        // via standard error semantics.
        //
        // `rebuild_from_workbook` parses every formula a second
        // time (the existing loop below also parses each via
        // `try_recompute_one_cached`). Acceptable cost for the
        // load/replay path; `recompute_dirty` is the performance
        // path with session-attached callers.
        //
        // **Post-audit closures (2026-05-18 Tier C1 audit):**
        //
        // - *Codex H-1*: cycled cells are now written in a pre-pass
        //   below, not lazily inside the eval loop. This matches
        //   `recompute_dirty`'s cycle-first ordering (see line 3160+
        //   below). Without the pre-pass, HashMap-order could
        //   evaluate a non-cycled dependent (`B1 = A1+1`) before the
        //   cycled cell (`A1 = A1+1`) was overwritten, and B1 would
        //   read A1's stale prior value.
        //
        // - *Codex H-2*: cycled-cell pre-pass also clears any
        //   pre-existing spill anchor at the same address before
        //   writing `#CIRC!`. Without this, an old `SEQUENCE(3)`
        //   spill anchor that gets overwritten with a circular
        //   formula leaves stale spill target overlays in A2/A3.
        //
        // - *Opus H-1*: bind-failed formula nodes (those whose
        //   parse/bind errored inside `rebuild_from_workbook`) are
        //   inserted into the session's cell index but registered
        //   with zero outgoing edges. Tarjan therefore cannot place
        //   them in a non-trivial SCC nor mark them as self-loops,
        //   so the `cycled` set correctly excludes them. They flow
        //   into the existing HashMap-order eval loop and the
        //   parse/bind error surfaces via the normal `failures`
        //   pathway.
        let cycled_cells: std::collections::HashSet<(SheetId, RowId, ColId)> = {
            use crate::calcgraph_session::CalcgraphSession;
            let mut session = CalcgraphSession::rebuild_from_workbook(self.workbook).session;
            let formula_addrs: Vec<(SheetId, RowId, ColId)> = self
                .workbook
                .iter_formulas()
                .map(|(s, r, c, _)| (s, r, c))
                .collect();
            for (s, r, c) in &formula_addrs {
                if let Some(node) = session.cell_node_for(*s, *r, *c) {
                    session.mark_dirty(node);
                }
            }
            let sched = session.schedule_dirty();
            sched
                .cycled
                .into_iter()
                .filter_map(|n| session.cell_address_for(n))
                .collect()
        };

        // **Codex H-1 / H-2 closure pre-pass:** write `#CIRC!` to
        // every cycled cell BEFORE running the HashMap-order eval
        // loop, and clear any spill anchor that previously lived at
        // the same address. Order matters: writing `#CIRC!` before
        // the loop guarantees a non-cycled dependent that reads
        // from a cycled cell sees the error sigil and propagates
        // it, instead of reading a stale prior value.
        for &(sheet, row, col) in &cycled_cells {
            self.workbook.clear_spill_if_present((sheet, row, col));
            self.workbook
                .put_computed_at(sheet, row, col, Value::Error(ErrorValue::Circ));
        }

        // Snapshot the formula list so we don't hold a borrow during eval.
        let entries: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
            .workbook
            .iter_formulas()
            .map(|(s, r, c, f)| (s, r, c, Arc::clone(f)))
            .collect();
        let attempted = entries.len();
        let mut succeeded = 0;
        let mut failures: Vec<RecomputeFailure> = Vec::new();

        for (sheet, row, col, formula_text) in entries {
            // Tier C1: cycled cells were already written to `#CIRC!`
            // in the pre-pass above and any stale spill cleared.
            // Match `recompute_dirty`'s cycled-cell accounting:
            // cycled cells contribute to `attempted` but NOT to
            // `succeeded` (the VEQ short-circuit logic that
            // `recompute_dirty` runs in addition does not apply
            // here — `recompute_all` is the legacy full-pass path).
            if cycled_cells.contains(&(sheet, row, col)) {
                continue;
            }
            match self.try_recompute_one_cached(sheet, row, col, &formula_text) {
                Ok(value) => {
                    // Phase 3.5 (CORR-25): formula outputs route to the
                    // COMPUTED overlay, never the user lane.
                    self.workbook.put_computed_at(sheet, row, col, value);
                    succeeded += 1;
                }
                Err(error) => {
                    // **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):**
                    // mirror `recompute_dirty`'s table-bind-error
                    // mapping so the recompute_all path (used by
                    // replay + headless callers) also honors
                    // design § 12.4 — dropped-table refs emit
                    // `#NAME?`, not a recompute failure with a
                    // stale cell value.
                    if let RuntimeError::Bind(
                        BindError::UnknownTable(_) | BindError::UnknownTableColumn { .. },
                    ) = &error
                    {
                        self.workbook.put_computed_at(
                            sheet,
                            row,
                            col,
                            Value::Error(ErrorValue::Name),
                        );
                        succeeded += 1;
                    } else {
                        failures.push(RecomputeFailure {
                            sheet,
                            row,
                            col,
                            formula_text,
                            error,
                        });
                    }
                }
            }
        }

        RecomputeResult {
            attempted,
            succeeded,
            failures,
            // Phase 3.8: `recompute_all` doesn't run the VEQ check —
            // it's the HashMap-order legacy path that always
            // re-evaluates everything. `recompute_dirty` is the path
            // that benefits from value-equality short-circuit.
            skipped_value_equality: 0,
            // Phase 3.9: SIMD-eligibility profile is recompute_dirty-
            // only. `recompute_all` is the legacy full-pass path.
            simd_classified: 0,
        }
    }

    /// **Engine Phase 3.4 (2026-05-12) — W5-37 SCH-3-01..04 entry
    /// point.** Recompute only the formulas the attached
    /// [`CalcgraphSession`] has marked dirty since the last call.
    /// The scheduler runs iterative Tarjan SCC over the dirty
    /// subset; nodes in non-trivial SCCs (or with self-loops) are
    /// written as `Value::Error(ErrorValue::Circ)`. Everything else
    /// is evaluated in topological order via the existing PlanCache
    /// pipeline.
    ///
    /// Returns `None` when no `CalcgraphSession` is attached (the
    /// runtime was constructed via `new` or `with_oplog`); the
    /// dirty-set lives on the session, so we can't do incremental
    /// recompute without it. Callers in that mode should use
    /// `recompute_all` for a full HashMap-order pass instead.
    ///
    /// Returns `Some(RecomputeResult)` otherwise, matching the
    /// aggregation shape of `recompute_all`: per-cell failures
    /// (parse / bind issues that have somehow surfaced post-bind,
    /// e.g. a name was deleted between extract and recompute) are
    /// collected, the rest succeed.
    pub fn recompute_dirty(&mut self) -> Option<RecomputeResult> {
        // The session lives behind an `Option<&'a mut CalcgraphSession>`
        // — take it out for the duration of this call so we can borrow
        // both the workbook and the session simultaneously. Reattach
        // before returning.
        let mut session_slot = self.graph.take();
        let session = session_slot.as_deref_mut()?;

        // **W5-106 (Phase 4.7.M / task #136 closure)**: fixed-point
        // loop. Each iteration:
        //   1. claim + schedule the current dirty set.
        //   2. snapshot prior + originally_dirty for newly-seen nodes
        //      (carry across iterations so VEQ short-circuit still
        //      works on second-iter D1's that depend on iter-1
        //      formulas).
        //   3. evaluate cycled + sorted.
        //   4. if write_spill fired during the sorted loop, it called
        //      on_set_value at spill-footprint cells, adding to dirty.
        //   5. loop until session.dirty is empty.
        //
        // Bounded by `MAX_ITERATIONS` to prevent runaway in pathological
        // cases (a workbook configuration that would not terminate).
        // 100 is generous — any single set_value edit normally needs
        // ≤ 2 iterations (one for the initial dirty set, one for spill
        // shape-transition follow-ups).
        const MAX_ITERATIONS: usize = 100;
        let mut attempted: usize = 0;
        let mut succeeded = 0;
        let mut failures: Vec<RecomputeFailure> = Vec::new();
        let mut skipped_value_equality: usize = 0;
        // Phase 3.9 (W5-42): SIMD-eligibility profile. V1 observability
        // only.
        let mut simd_classified: usize = 0;

        // Phase 3.8 (W5-41, VEQ-3-01..03) — value-equality short-
        // circuit. State accumulates across fixed-point iterations:
        //   - `prior`: workbook value at each first-seen node, captured
        //     BEFORE that iteration's evaluation. Carries across iters
        //     so VEQ comparisons stay anchored to the pre-recompute
        //     value, not intermediate spill-write values.
        //   - `originally_dirty`: NodeIds claimed by ANY iteration's
        //     schedule. Used to distinguish "top-level dirty" from
        //     "downstream dirty" for the VEQ decision.
        //   - `changed`: addresses whose value differs from `prior`
        //     after any iteration's write. Built up across iters.
        use std::collections::{HashMap, HashSet};
        let mut prior: HashMap<(SheetId, RowId, ColId), Value> = HashMap::new();
        let mut originally_dirty: HashSet<ql_calcgraph::NodeId> = HashSet::new();
        let mut changed: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
        // **Codex audit MEDIUM closure**: surface iteration-cap hits
        // instead of silently breaking. After the loop, if `iter_count`
        // reached MAX_ITERATIONS AND session.dirty() is still non-empty,
        // surface a synthetic failure so the caller's `is_complete()`
        // check (which inspects `failures.is_empty()`) signals the
        // problem.
        let mut iter_count: usize = 0;

        for _iter in 0..MAX_ITERATIONS {
            iter_count += 1;
            // Phase 3.4: claim dirty + topo-sort. Edges in the graph
            // model the dep direction (`outgoing(F) = what F depends on`).
            // Tarjan emits SCCs in reverse-topo of the condensation
            // which, for our edge orientation, is dependency-first order.
            let sched = session.schedule_dirty();
            if sched.total_count() == 0 {
                break; // Fixed point reached.
            }
            attempted += sched.total_count();

            // Snapshot prior + originally_dirty for newly-seen nodes.
            for n in sched.sorted.iter().chain(sched.cycled.iter()) {
                originally_dirty.insert(*n);
                if let Some(addr) = session.cell_address_for(*n) {
                    prior.entry(addr).or_insert_with(|| {
                        self.workbook
                            .read(ql_types::Address::new(addr.0, addr.1, addr.2))
                    });
                }
            }

            // Cycled nodes get `#CIRC!` regardless of whether the
            // formula still binds. Phase 3.5: routes to the computed
            // overlay. Phase 3.8: still apply value-equality.
            let circ = Value::Error(ErrorValue::Circ);
            for node in &sched.cycled {
                let Some((sheet, row, col)) = session.cell_address_for(*node) else {
                    continue;
                };
                let prior_val = prior.get(&(sheet, row, col));
                if prior_val == Some(&circ) {
                    skipped_value_equality += 1;
                } else {
                    self.workbook.put_computed_at(sheet, row, col, circ.clone());
                    changed.insert((sheet, row, col));
                }
            }

            // Sorted nodes evaluate in dependency-first order.
            for node in &sched.sorted {
                let Some((sheet, row, col)) = session.cell_address_for(*node) else {
                    continue;
                };
                let Some(text) = self.workbook.formula_at(sheet, row, col).cloned() else {
                    continue;
                };

                // Phase 3.8: VEQ decision — does any upstream of `node`
                // have a reason to recompute? Cases:
                //   a) Volatile (NOW/RAND/etc.) — always re-eval (its
                //      value can change without any cell edit).
                //   b) Has named-range deps — V1 conservatively re-evals
                //      (we don't track per-cell-in-range changes yet).
                //   c) Has at least one direct-cell dep that's a
                //      formula in the original dirty set AND that
                //      formula's value changed → re-eval.
                //   d) Has NO direct-cell dep that's in the original
                //      dirty set (top-level dirty; came from an external
                //      edit) → re-eval.
                //   e) All direct-cell deps are in the dirty set but
                //      none ended up in `changed` → SKIP.
                let is_volatile = session.is_volatile(*node);
                let needs_eval = if is_volatile {
                    true
                } else if let Some(deps) = session.formula_deps(*node) {
                    if !deps.named_ranges.is_empty() {
                        true
                    } else {
                        let mut had_dirty_dep = false;
                        let mut had_changed_dep = false;
                        // **Codex audit HIGH-1 closure**: VEQ-defeat for
                        // producer-aliased deps. A dep that resolves to a
                        // current spill ANCHOR may have target-value
                        // changes that the VEQ "changed[anchor]" set
                        // doesn't capture (anchor value can be invariant
                        // while target values change — e.g.
                        // SEQUENCE(3,1,1,A1)'s start=1 is fixed but
                        // step depends on A1, so C2/C3 vary). Force
                        // re-eval whenever a dep is a CURRENT spill
                        // anchor and was dirty in some iteration.
                        let mut had_aliased_dirty_dep = false;
                        for &(ds, dr, dc) in &deps.cells {
                            if let Some(dep_node) = session.cell_node_for(ds, dr, dc) {
                                if originally_dirty.contains(&dep_node) {
                                    had_dirty_dep = true;
                                    if changed.contains(&(ds, dr, dc)) {
                                        had_changed_dep = true;
                                        break;
                                    }
                                    if self.workbook.spill_anchor_at(ds, dr, dc).is_some() {
                                        had_aliased_dirty_dep = true;
                                    }
                                }
                            }
                        }
                        // Re-eval if: top-level dirty (no dirty dep),
                        // OR a dirty dep value-changed,
                        // OR a dirty dep is a spill anchor (target
                        //    values may have changed even if anchor
                        //    value didn't).
                        !had_dirty_dep || had_changed_dep || had_aliased_dirty_dep
                    }
                } else {
                    // No tracked deps (e.g., `=1+1`). Treat as top-level.
                    true
                };

                if !needs_eval {
                    skipped_value_equality += 1;
                    continue;
                }

                // Phase 3.6 (W5-39): route through the session's aggregate
                // cache so `SUM(Sales)`-style formulas hit the cache when
                // no cell inside `Sales` changed (AGG-3-01).
                // Phase 3.9 (W5-42): also classify the plan for SIMD
                // eligibility (SIMD-3-03 profile). We need the plan
                // post-bind — call a slightly-expanded helper that
                // returns the value AND the SimdShape classification.
                let agg_cache = session.aggregate_cache();
                match self.try_recompute_with_simd_profile(sheet, row, col, &text, agg_cache) {
                    Ok((value, simd_eligible, old_spill_shape, new_spill_shape)) => {
                        if simd_eligible {
                            simd_classified += 1;
                        }
                        // Phase 3.8: value-equality check. If the freshly-
                        // computed value matches the snapshot, suppress
                        // the write entirely and don't record this cell
                        // as `changed` — downstream formulas that depend
                        // only on this one will skip too.
                        let prior_val = prior.get(&(sheet, row, col));
                        if prior_val == Some(&value) {
                            skipped_value_equality += 1;
                        } else {
                            self.workbook.put_computed_at(sheet, row, col, value);
                            changed.insert((sheet, row, col));
                        }
                        // **Task #136 hook pass (recompute_dirty side)**: if
                        // the formula's spill shape changed (or was a new
                        // spill, or just dissolved), fire on_set_value at
                        // each non-anchor cell in the UNION of (old, new)
                        // footprints. Readers indexed under those cells
                        // get marked dirty; the fixed-point loop picks them
                        // up in a follow-up iteration.
                        //
                        // **Codex audit HIGH-1 closure**: ALSO fire
                        // on_set_value(anchor) — `cell_to_formulas[anchor]`
                        // holds readers producer-aliased to this spill
                        // (4.7.I). They need to dirty even if the anchor's
                        // OWN value is VEQ-unchanged, because TARGET values
                        // may have changed (e.g. SEQUENCE(3,1,1,A1): anchor
                        // value = start = 1 invariant, but C2/C3 vary with
                        // A1). Over-conservative for direct readers of the
                        // anchor (they'd re-eval to the same value and
                        // VEQ-skip the write), but correct.
                        if old_spill_shape.is_some() || new_spill_shape.is_some() {
                            use std::collections::HashSet;
                            let mut affected: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
                            for shape in [old_spill_shape, new_spill_shape].into_iter().flatten() {
                                for dr in 0..shape.rows {
                                    for dc in 0..shape.cols {
                                        if dr == 0 && dc == 0 {
                                            continue;
                                        }
                                        affected.insert((sheet, row + dr, col + dc));
                                    }
                                }
                            }
                            for (s, r, c) in affected {
                                session.on_set_value(s, r, c);
                            }
                            // Anchor cell — dirties aliased readers.
                            session.on_set_value(sheet, row, col);

                            // **Codex audit HIGH-2 closure**: re-extract
                            // readers in the (old, new) footprint. Mirrors
                            // set_formula's 4.7.J.4 pattern. Required for
                            // dissolution-via-recompute: aliased readers'
                            // deps stay pointing at the dissolved anchor;
                            // future writes to actually-read cells (e.g.
                            // user typing into a now-free target) miss
                            // the reader without re-extraction.
                            //
                            // Inlined (can't call self.reextract_spill_footprint_readers
                            // because it accesses self.graph which is None
                            // during recompute_dirty's session_slot window).
                            let mut seen: HashSet<ql_calcgraph::NodeId> = HashSet::new();
                            let mut readers: Vec<(
                                ql_calcgraph::NodeId,
                                SheetId,
                                RowId,
                                ColId,
                                Arc<str>,
                            )> = Vec::new();
                            for shape in [old_spill_shape, new_spill_shape].into_iter().flatten() {
                                for n in
                                    session.readers_in_rect(sheet, row, col, shape.rows, shape.cols)
                                {
                                    if !seen.insert(n) {
                                        continue;
                                    }
                                    let Some((s, r, c)) = session.cell_address_for(n) else {
                                        continue;
                                    };
                                    if (s, r, c) == (sheet, row, col) {
                                        continue;
                                    }
                                    let Some(text) = self.workbook.formula_at(s, r, c).cloned()
                                    else {
                                        continue;
                                    };
                                    readers.push((n, s, r, c, text));
                                }
                            }
                            for (rn, reader_sheet, reader_row, reader_col, reader_text) in readers {
                                let name_gen = self.workbook.names().generation();
                                // **W5-150 (Phase 4.9.O HIGH-1):** cell-aware key when `@`
                                // is present.
                                let cell_anchor = if reader_text.contains('@') {
                                    Some((reader_row, reader_col))
                                } else {
                                    None
                                };
                                let cache_key = PlanCacheKey {
                                    text: Arc::clone(&reader_text),
                                    sheet: reader_sheet,
                                    name_gen,
                                    cell_anchor,
                                };
                                let workbook: &Workbook = self.workbook;
                                let plan: Arc<crate::plan::ExprPlan> =
                                    match self.plan_cache.get_or_insert::<_, RuntimeError>(
                                        cache_key,
                                        || {
                                            let tokens = lex(reader_text.as_ref())?;
                                            let expr = parse(tokens)?;
                                            // **W5-114 (Phase 4.8.E):** reader cell addr.
                                            Ok(bind_with_site(
                                                &expr,
                                                BindSite::at_cell(ql_types::Address::new(
                                                    reader_sheet,
                                                    reader_row,
                                                    reader_col,
                                                )),
                                                workbook,
                                                workbook,
                                                workbook,
                                            )?)
                                        },
                                    ) {
                                        Ok(p) => p,
                                        Err(_) => {
                                            // No-fallbacks rule: bind failure
                                            // here mirrors set_formula path's
                                            // mark_dirty handling — surface at
                                            // reader's own recompute next time.
                                            session.mark_dirty(rn);
                                            continue;
                                        }
                                    };
                                session.reextract_deps(rn, plan.as_ref(), self.workbook);
                                session.mark_dirty(rn);
                            }
                        }
                        succeeded += 1;
                    }
                    Err(error) => {
                        // **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):**
                        // table-related bind failures during recompute
                        // emit `#NAME?` per design § 12.4 ("re-bind to
                        // BindError::UnknownTable → emit #NAME?") and
                        // the `plan.rs:260` UnknownTable docstring.
                        // Typical trigger: `drop_table` invalidates the
                        // plan cache (W5-156 HIGH-1 fix), the on_table_drop
                        // hook marks the reader dirty, recompute re-binds
                        // and discovers the table is gone. Without this
                        // mapping the cell would keep its pre-drop value
                        // (failures collection only surfaces the error
                        // to the caller; the cell overlay stays stale).
                        // Counts as `succeeded` because the formula
                        // evaluated to a well-defined error value, not
                        // a structural recompute failure.
                        if let RuntimeError::Bind(
                            BindError::UnknownTable(_) | BindError::UnknownTableColumn { .. },
                        ) = &error
                        {
                            let v = Value::Error(ErrorValue::Name);
                            let prior_val = prior.get(&(sheet, row, col));
                            if prior_val == Some(&v) {
                                skipped_value_equality += 1;
                            } else {
                                self.workbook.put_computed_at(sheet, row, col, v);
                                changed.insert((sheet, row, col));
                            }
                            succeeded += 1;
                        } else {
                            failures.push(RecomputeFailure {
                                sheet,
                                row,
                                col,
                                formula_text: text,
                                error,
                            });
                        }
                    }
                }
            }
        } // end MAX_ITERATIONS loop

        // **Codex audit MEDIUM closure**: if we hit MAX_ITERATIONS
        // AND session.dirty() is still non-empty, the fixed point
        // wasn't reached. Surface as a synthetic RecomputeFailure
        // so the caller's is_complete() check signals the problem
        // instead of silently returning what looks like a clean
        // recompute. Per CLAUDE.md no-fallbacks rule.
        if iter_count == MAX_ITERATIONS && !session.dirty_formulas().is_empty() {
            failures.push(RecomputeFailure {
                sheet: 0,
                row: 0,
                col: 0,
                formula_text: Arc::from(format!(
                    "recompute_dirty hit MAX_ITERATIONS={MAX_ITERATIONS} \
                     with {} cells still dirty — possible runaway spill \
                     shape transition or workbook misconfiguration",
                    session.dirty_formulas().len()
                )),
                error: RuntimeError::RecomputeIterationCap,
            });
        }

        self.graph = session_slot;
        Some(RecomputeResult {
            attempted,
            succeeded,
            failures,
            skipped_value_equality,
            simd_classified,
        })
    }

    /// Phase 2B.3 helper for `recompute_all`: consult the bind-plan cache
    /// before doing lex/parse/bind work, then evaluate. Failures (lex /
    /// parse / bind) propagate as `RuntimeError`; the caller bundles them
    /// into a `RecomputeFailure`. Successful binds are cached so a
    /// subsequent recompute (or a `set_formula` editing a nearby cell
    /// with the same text) hits.
    ///
    /// Phase 3.6 (W5-39): this is the no-aggregate-cache wrapper. The
    /// `recompute_dirty` path uses
    /// [`Self::try_recompute_with_aggregate_cache`] which threads the
    /// session's aggregate cache through the evaluator.
    fn try_recompute_one_cached(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &Arc<str>,
    ) -> Result<Value, RuntimeError> {
        self.try_recompute_with_aggregate_cache(
            sheet,
            row,
            col,
            formula_text,
            &crate::aggregate_cache::NoAggregateCache,
        )
    }

    /// Phase 3.6 (W5-39): variant of `try_recompute_one_cached` that
    /// threads an `AggregateCache` through the scalar evaluator so
    /// `SUM(Sales)` / `AVERAGE(Sales)` calls consult + populate the
    /// cache. Used by `recompute_dirty` which owns a session-side
    /// `InMemAggregateCache`.
    ///
    /// **W5-103 (#128):** also takes `row, col` so the spill-writeback
    /// branch inside `try_recompute_with_simd_profile` can materialize
    /// arrays at the correct anchor cell.
    fn try_recompute_with_aggregate_cache(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &Arc<str>,
        agg_cache: &dyn crate::aggregate_cache::AggregateCache,
    ) -> Result<Value, RuntimeError> {
        self.try_recompute_with_simd_profile(sheet, row, col, formula_text, agg_cache)
            .map(|(v, _, _, _)| v)
    }

    /// Phase 3.9 (W5-42): like `try_recompute_with_aggregate_cache`
    /// but ALSO returns a `bool` for whether the formula's bound plan
    /// was SIMD-eligible per `crate::lower::classify`. The bool is
    /// pure observability — the actual SIMD dispatch via `simd::*`
    /// happens at the bench / FormulaRegion path. `recompute_dirty`
    /// uses this to populate `RecomputeResult.simd_classified` so the
    /// IDE profile can show where region optimization would help.
    fn try_recompute_with_simd_profile(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &Arc<str>,
        agg_cache: &dyn crate::aggregate_cache::AggregateCache,
    ) -> Result<(Value, bool, Option<SpillShape>, Option<SpillShape>), RuntimeError> {
        let name_gen = self.workbook.names().generation();
        // **W5-150 (Phase 4.9.O HIGH-1):** cell-aware key when `@`
        // is present in the stored formula text. This is the
        // recompute path — same canonical text at different cells
        // would otherwise share the cell-specific `@`-narrowed
        // plan from the first bind, leaking the wrong cell ref.
        let cell_anchor = if formula_text.contains('@') {
            Some((row, col))
        } else {
            None
        };
        let cache_key = PlanCacheKey {
            text: Arc::clone(formula_text),
            sheet,
            name_gen,
            cell_anchor,
        };
        // Borrow split: we need an immutable view of the workbook
        // (for `names()` inside the closure) while holding a mutable
        // borrow on `self.plan_cache`. Re-borrow the workbook reference
        // by name so Rust's borrow checker can split them — both fields
        // are disjoint subfields of `self`.
        let workbook: &Workbook = self.workbook;
        let plan: Arc<crate::plan::ExprPlan> =
            self.plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    // **W5-147 (Phase 4.9.K):** formula_text here is the
                    // CANONICAL (A1+EnUs) text stored at set_formula
                    // time. Lex with the canonical mode/locale —
                    // regardless of the workbook's current
                    // reference_mode + locale settings, the stored text
                    // is always A1+EnUs per design § 4.4.
                    let tokens = lex_with(
                        formula_text.as_ref(),
                        ql_types::ReferenceMode::A1,
                        ql_types::Locale::EnUs,
                    )?;
                    let expr = parse(tokens)?;
                    // W5-92 (Phase 4.6.D): pass `workbook` for names so
                    // the two-tier sheet-then-workbook scope chain fires.
                    // **W5-114 (Phase 4.8.E):** carry recomputed cell address.
                    Ok(bind_with_site(
                        &expr,
                        BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
                        workbook,
                        workbook,
                        workbook,
                    )?)
                })?;

        // Phase 3.9: classify the plan against the SIMD kernel set.
        // Pure function over the plan tree; no allocation.
        let simd_eligible = crate::lower::classify(plan.as_ref()).is_applicable();

        // **W5-103 megaudit HIGH-2 closure (#128, all 3 reviewers
        // cross-confirmed):** route through `eval_at_cell_boundary`
        // (same entry set_formula uses) so a top-level
        // `ExprPlan::Array` produces an `EvalResult::Array` here and
        // materializes via `write_spill` — instead of collapsing to
        // `#CALC!` (which `eval_scalar_with_cache` returns per the
        // scalar-context contract at scalar.rs:95).
        //
        // Without this, op-log replay of `PutFormula { text: "{1,2,3}" }`
        // followed by `recompute_all` would write #CALC! at the
        // anchor instead of spilling — design § 7.3/§ 12.3
        // "load → recompute re-derives spills" contract broken,
        // persistence layer (4.7.L) hard-blocked.
        //
        // The clear-old + write_spill sequence mirrors set_formula's
        // 4.7.J.2 pattern. Unlike set_formula, we DO NOT fire
        // on_set_formula / on_set_value / re-extract hooks: recompute
        // doesn't change a formula's identity, only its computed
        // value. Downstream readers were already dirtied by whatever
        // made THIS formula dirty in the first place.
        //
        // **W5-108 (Phase 4.7.O) — Codex MEDIUM-5 closure**: clear
        // the OLD spill footprint BEFORE eval, matching design § 10.3
        // step 4 ("clear-old-before-eval") and `set_formula`'s
        // identical ordering at line 621. Pre-fix ordering was
        // eval → clear → write, which let a formula's eval observe
        // its own OLD spill-target computed overlays through indirect
        // reads (named ranges, aggregates). Direct self-reads create
        // a producer-alias self-loop (Tarjan → #CIRC!) so the gap was
        // narrow, but the design contract is "clear-before-eval" and
        // bringing the code into alignment removes a latent
        // composition footgun.
        //
        // We capture old_spill_shape BEFORE clear so the caller
        // (recompute_dirty's fixed-point loop) can fire hooks for the
        // dissolved footprint after eval+write_spill complete.
        let old_spill_shape = self.workbook.spill_anchor_at(sheet, row, col).copied();
        self.workbook.clear_spill_if_present((sheet, row, col));

        let result: crate::eval_result::EvalResult = {
            // **W5-117 (Phase 4.8.G.2):** carry recomputed cell for
            // structured-ref `[@Col]` row narrowing.
            let env = WorkbookEnv::with_formula_cell(
                self.workbook,
                ql_types::Address::new(sheet, row, col),
            );
            crate::scalar::eval_at_cell_boundary(plan.as_ref(), &env, self.registry, agg_cache)
        };

        // **Note (Sonnet #128 LOW-1, deferred):** the Array arm here
        // writes the anchor via `write_spill`; the caller also
        // `put_computed_at(anchor, anchor_value)` — a no-op duplicate
        // write. Deferred; harmless.
        //
        // **W5-106 (Phase 4.7.M / task #136 closure)**: capture the
        // NEW shape via write_spill's return. We DON'T fire
        // on_set_value hooks here — the caller (recompute_dirty in
        // particular) owns the session reference at this scope
        // (recompute_dirty `take()`s `self.graph` into a local, so
        // `self.graph` is `None` during the sorted loop). Bubble the
        // shape info up via the return; the caller fires hooks
        // against its session.
        let (anchor_value, new_spill_shape) = match result {
            crate::eval_result::EvalResult::Scalar(v) => (v, None),
            crate::eval_result::EvalResult::Array(array) => {
                let formula_text_arc = self
                    .workbook
                    .formula_at(sheet, row, col)
                    .cloned()
                    .expect("recompute: formula_at MUST be Some — we're recomputing this cell");
                self.write_spill(sheet, row, col, array, formula_text_arc)
            }
        };

        Ok((
            anchor_value,
            simd_eligible,
            old_spill_shape,
            new_spill_shape,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_functions::default_registry;
    use ql_types::ErrorValue;

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== set_formula =====

    #[test]
    fn set_formula_literal_arithmetic() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "1 + 2 * 3").unwrap();
        assert_eq!(v, Value::Number(7.0));
        // Persisted: both the formula and the value.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(7.0));
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("1 + 2 * 3")
        );
    }

    #[test]
    fn set_formula_reads_existing_cell() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // =A1 * 2 → 20
        let v = rt.set_formula(0, 1, 0, "A1 * 2").unwrap();
        assert_eq!(v, Value::Number(20.0));
    }

    #[test]
    fn set_formula_with_function_call() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_at(0, 1, 0, Value::Number(20.0));
        wb.put_at(0, 2, 0, Value::Number(30.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // =SUM(A1, A2, A3) → 60
        let v = rt.set_formula(0, 0, 1, "SUM(A1, A2, A3)").unwrap();
        assert_eq!(v, Value::Number(60.0));
    }

    #[test]
    fn set_formula_propagates_div_by_zero() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "10 / 0").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::DivZero));
        // Even error-evaluated formulas persist their text.
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("10 / 0"));
    }

    #[test]
    fn set_formula_invalid_syntax_returns_parse_error() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Unclosed paren — guaranteed parse error.
        let result = rt.set_formula(0, 0, 0, "(1 + 2");
        assert!(
            matches!(result, Err(RuntimeError::Parse(_))),
            "expected Parse error, got {result:?}"
        );
        // No partial write on parse failure.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Blank);
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    #[test]
    fn set_formula_trailing_tokens_returns_parse_error() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_formula(0, 0, 0, "1 + 2 3");
        assert!(matches!(result, Err(RuntimeError::Parse(_))));
        // No partial write.
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// Phase 2A.5 (2026-05-12): `=VAR.S(1, 2, 3)` end-to-end — lexer accepts the
    /// dotted identifier, parser builds Expr::Function { name: "VAR.S" }, binder
    /// produces ExprPlan::Function, scalar evaluator dispatches via the registry
    /// to the variance kernel. Sample variance of {1,2,3} is 1.0.
    #[test]
    fn set_formula_var_s_dotted_function_dispatches() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "VAR.S(1, 2, 3)").unwrap();
        assert_eq!(v, Value::Number(1.0));
    }

    #[test]
    fn set_formula_stdev_p_dotted_function_dispatches() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Population stdev of {2, 4, 4, 4, 5, 5, 7, 9} is exactly 2.0 (textbook).
        let v = rt
            .set_formula(0, 0, 0, "STDEV.P(2, 4, 4, 4, 5, 5, 7, 9)")
            .unwrap();
        assert_eq!(v, Value::Number(2.0));
    }

    #[test]
    fn set_formula_ai_returns_ai_not_available() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "AI(\"prompt\")").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::AINotAvailable));
    }

    // ===== set_value =====

    #[test]
    fn set_value_clears_existing_formula() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // First set a formula.
        rt.set_formula(0, 0, 0, "1 + 1").unwrap();
        assert!(wb.formula_at(0, 0, 0).is_some());

        // Now set a literal — should clear the formula.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 0, 0, Value::Number(42.0)).unwrap();
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Number(42.0)
        );
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// Phase 2A.6 audit H1/L4 (2026-05-12): invalid sheet ids surface as
    /// `RuntimeError::InvalidSheet` instead of panicking inside `Workbook::put_at`.
    #[test]
    fn set_formula_rejects_invalid_sheet() {
        let mut wb = make_runtime_workbook(); // 1 sheet
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_formula(99, 0, 0, "1 + 1");
        match result {
            Err(RuntimeError::InvalidSheet { sheet, sheet_count }) => {
                assert_eq!(sheet, 99);
                assert_eq!(sheet_count, 1);
            }
            other => panic!("expected InvalidSheet, got {other:?}"),
        }
    }

    /// Phase 2A.7 audit H1 (2026-05-12): out-of-grid row or col now surfaces as
    /// `RuntimeError::InvalidCell` instead of panicking inside `Sheet::put`.
    #[test]
    fn set_formula_rejects_row_above_max() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // MAX_ROW = 1,048,575 — anything above is invalid.
        let result = rt.set_formula(0, 1_048_576, 0, "1 + 1");
        match result {
            Err(RuntimeError::InvalidCell {
                sheet,
                row,
                col,
                why,
            }) => {
                assert_eq!((sheet, row, col), (0, 1_048_576, 0));
                assert!(why.contains("row"));
            }
            other => panic!("expected InvalidCell with row > MAX_ROW, got {other:?}"),
        }
    }

    #[test]
    fn set_formula_rejects_col_above_max() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // MAX_COLUMN = 16,383 — anything above is invalid.
        let result = rt.set_formula(0, 0, 16_384, "1 + 1");
        match result {
            Err(RuntimeError::InvalidCell {
                sheet,
                row,
                col,
                why,
            }) => {
                assert_eq!((sheet, row, col), (0, 0, 16_384));
                assert!(why.contains("col"));
            }
            other => panic!("expected InvalidCell with col > MAX_COLUMN, got {other:?}"),
        }
    }

    #[test]
    fn set_value_rejects_invalid_cell() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_value(0, 9_999_999, 0, Value::Number(1.0));
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidCell { row: 9_999_999, .. })
            ),
            "expected InvalidCell, got {result:?}"
        );
    }

    #[test]
    fn set_formula_at_max_row_max_col_ok() {
        // Boundary case: exactly MAX_ROW and MAX_COLUMN are accepted.
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 1_048_575, 16_383, "1 + 1").unwrap();
        assert_eq!(v, Value::Number(2.0));
    }

    #[test]
    fn set_value_rejects_invalid_sheet() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_value(5, 0, 0, Value::Number(1.0));
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidSheet {
                    sheet: 5,
                    sheet_count: 1
                })
            ),
            "expected InvalidSheet, got {result:?}"
        );
    }

    #[test]
    fn set_value_on_blank_cell_no_formula() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        rt.set_value(0, 0, 0, Value::text("hello")).unwrap();
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::text("hello")
        );
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    // ===== recompute_all =====

    #[test]
    fn recompute_all_on_empty_workbook_is_noop() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.recompute_all();
        assert_eq!(result.attempted, 0);
        assert_eq!(result.succeeded, 0);
        assert!(result.is_complete());
    }

    #[test]
    fn recompute_all_refreshes_formula_values() {
        let mut wb = make_runtime_workbook();

        // Set up scenario: A1 = 5; B1 has formula =A1 * 2 evaluated as 10.
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_at(0, 0, 1, Value::Number(10.0));
        wb.put_formula(0, 0, 1, "A1 * 2");

        // Change A1 to 100 (simulating a user edit that didn't auto-recompute).
        wb.put_at(0, 0, 0, Value::Number(100.0));
        // B1 still shows 10 (stale).
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(10.0)
        );

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.attempted, 1);
        assert_eq!(result.succeeded, 1);
        assert!(result.is_complete());

        // B1 now shows 200 (refreshed).
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(200.0)
        );
    }

    #[test]
    fn recompute_all_handles_multiple_formulas() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(2.0));

        // Add 3 formula cells all referring to A1.
        wb.put_at(0, 1, 0, Value::Number(0.0)); // stale
        wb.put_formula(0, 1, 0, "A1 + 1");
        wb.put_at(0, 2, 0, Value::Number(0.0));
        wb.put_formula(0, 2, 0, "A1 * 10");
        wb.put_at(0, 3, 0, Value::Number(0.0));
        wb.put_formula(0, 3, 0, "A1 - 100");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.succeeded, 3);
        assert!(result.is_complete());

        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(3.0));
        assert_eq!(
            wb.read(ql_types::Address::new(0, 2, 0)),
            Value::Number(20.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 3, 0)),
            Value::Number(-98.0)
        );
    }

    /// End-to-end: save a workbook with formulas, load it, recompute, verify the
    /// values match. This is the full live-formula round-trip use case the IDE
    /// will exercise.
    #[test]
    fn save_load_recompute_e2e() {
        use tempfile::TempDir;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rt.qbook");

        // Build a workbook with a formula.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(7.0));
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(s, 1, 0, "A1 * 3").unwrap();
            // B1 should now be 21.
        }
        assert_eq!(
            wb.read(ql_types::Address::new(s, 1, 0)),
            Value::Number(21.0)
        );

        // Save + load.
        ql_io::save_workbook(&wb, "rt-e2e", &path).unwrap();
        let mut loaded = ql_io::load_workbook(&path).unwrap();

        // Loaded value should match (because saved evaluated value was 21).
        assert_eq!(
            loaded.read(ql_types::Address::new(s, 1, 0)),
            Value::Number(21.0)
        );
        // Formula text preserved.
        assert_eq!(
            loaded.formula_at(s, 1, 0).map(|s| s.as_ref()),
            Some("A1 * 3")
        );

        // Now simulate a stale-value scenario: edit A1 in the loaded workbook.
        loaded.put_at(s, 0, 0, Value::Number(100.0));
        // B1 still shows old value.
        assert_eq!(
            loaded.read(ql_types::Address::new(s, 1, 0)),
            Value::Number(21.0)
        );

        // Recompute refreshes everything.
        let mut rt = WorkbookRuntime::new(&mut loaded, &reg);
        let result = rt.recompute_all();
        assert!(result.is_complete());
        assert_eq!(
            loaded.read(ql_types::Address::new(s, 1, 0)),
            Value::Number(300.0)
        );
    }

    // ===== Phase 2A.1 — named-range resolution =====

    #[test]
    fn set_formula_resolves_named_cell_target() {
        use ql_storage::NamedTarget;
        use ql_types::Address;

        let mut wb = make_runtime_workbook();
        // A1 = 42; register MYREF → $A$1.
        wb.put_at(0, 0, 0, Value::Number(42.0));
        wb.set_name("MyRef", NamedTarget::Cell(Address::new(0, 0, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // =MyRef + 1 → 43. The bare ident parses as NameRef, the binder resolves
        // it to a CellRef via the workbook's name table.
        let v = rt.set_formula(0, 1, 0, "MyRef + 1").unwrap();
        assert_eq!(v, Value::Number(43.0));
    }

    #[test]
    fn set_formula_resolves_named_number_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        // TaxRate = 0.21 as a named constant.
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "100 * TaxRate").unwrap();
        assert_eq!(v, Value::Number(21.0));
    }

    #[test]
    fn set_formula_resolves_named_boolean_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        wb.set_name("UseFancy", NamedTarget::Constant(Value::Boolean(true)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Phase 0 binder accepts Boolean as ExprPlan::Bool literal. Evaluating
        // a bare NameRef should return the boolean.
        let v = rt.set_formula(0, 0, 0, "UseFancy").unwrap();
        assert_eq!(v, Value::Boolean(true));
    }

    #[test]
    fn set_formula_resolves_named_text_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        wb.set_name("Greeting", NamedTarget::Constant(Value::text("hello")))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "Greeting").unwrap();
        assert_eq!(v, Value::text("hello"));
    }

    #[test]
    fn set_formula_unresolved_name_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // No name registered → bind-time UnresolvedName, surfaced as RuntimeError::Bind.
        let result = rt.set_formula(0, 0, 0, "UnknownName + 1");
        match result {
            Err(RuntimeError::Bind(BindError::UnresolvedName(name))) => {
                assert_eq!(name.as_ref(), "UNKNOWNNAME");
            }
            other => panic!("expected Bind(UnresolvedName), got {other:?}"),
        }
        // No partial write on bind failure.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Blank);
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// Phase 2A.11 audit M16: error Display strings are human-readable, not
    /// Rust-debug syntax. Previously `RuntimeError::Bind(BindError::Unresolved
    /// Name("X"))` rendered via `{0:?}` and surfaced "bind error:
    /// UnresolvedName(\"X\")" — Rust debug format with an awkward bracket+
    /// quote spelling. Now reads "bind error: unresolved name \"X\"".
    #[test]
    fn runtime_error_bind_display_is_human_readable() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .set_formula(0, 0, 0, "UnknownName + 1")
            .expect_err("expected an error");
        let display = err.to_string();
        // The display contains the user-facing canonical name; no Rust
        // debug-syntax markers like `UnresolvedName(...)`.
        assert!(
            display.contains("UNKNOWNNAME"),
            "Display lost the name: {display:?}"
        );
        assert!(
            !display.contains("UnresolvedName"),
            "Display still leaks Rust variant syntax: {display:?}"
        );
    }

    #[test]
    fn runtime_error_lex_display_is_human_readable() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // **W5-143 (Phase 4.9.G):** `@` is now the implicit-intersection
        // operator, so it's no longer a lex error. Use backtick (`)
        // which has no Excel-formula lexical role and stays
        // unrepresentable.
        let err = rt
            .set_formula(0, 0, 0, "`foo")
            .expect_err("expected an error");
        let display = err.to_string();
        assert!(
            display.contains("unexpected character"),
            "Display lost the message: {display:?}"
        );
        // No debug-syntax leak like `UnexpectedChar('`')`.
        assert!(
            !display.contains("UnexpectedChar"),
            "Display still leaks Rust variant syntax: {display:?}"
        );
    }

    /// Phase 2B.4 (2026-05-12): named range in a bare scalar position now
    /// surfaces the precise `NamedRangeInScalarContext` instead of the
    /// generic `UnsupportedVariant`. Aggregate-context usage (e.g.
    /// `=SUM(Sales)`) is now accepted and binds to `ExprPlan::AggregateNameRef`.
    /// NAG-04 acceptance.
    #[test]
    fn set_formula_named_range_in_scalar_context_errors() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_formula(0, 0, 0, "Sales");
        match result {
            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(name))) => {
                // Parser canonicalizes to upper case.
                assert_eq!(name.as_ref(), "SALES");
            }
            other => panic!("expected Bind(NamedRangeInScalarContext), got {other:?}"),
        }
    }

    #[test]
    fn recompute_all_resolves_named_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        // Seed a formula manually (skipping set_formula) so recompute_all does the work.
        wb.put_at(0, 0, 0, Value::Number(0.0));
        wb.put_formula(0, 0, 0, "1000 * TaxRate");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.succeeded, 1);
        assert!(result.is_complete());
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Number(210.0)
        );
    }

    #[test]
    fn set_name_uppercases_for_canonical_lookup() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        // Register with mixed case — the parser will uppercase NameRef tokens, so
        // lookup must succeed regardless of how the source wrote the name.
        wb.set_name("MixedCaseName", NamedTarget::Constant(Value::Number(5.0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Lowercased reference still resolves.
        let v = rt.set_formula(0, 0, 0, "mixedcasename + 1").unwrap();
        assert_eq!(v, Value::Number(6.0));
    }

    // ===== Phase 2A.3.b — op-log producer wiring =====

    #[test]
    fn set_value_with_oplog_emits_put_value() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

        rt.set_value(0, 2, 3, Value::Number(42.0)).unwrap();
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::PutValue {
                sheet,
                row,
                col,
                value,
            } => {
                assert_eq!((*sheet, *row, *col), (0, 2, 3));
                assert_eq!(value, &CellWireValue::Number(42.0));
            }
            other => panic!("expected PutValue, got {other:?}"),
        }
    }

    #[test]
    fn set_value_over_existing_formula_emits_batch_commit_pair() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Seed a formula at (0, 0) via the runtime so the op log captures it.
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_formula(0, 0, 0, "1 + 1").unwrap();
            rt.set_value(0, 0, 0, Value::Number(99.0)).unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // Phase 2B.7 audit H2: the PutValue + ClearFormula pair now lands
        // as one atomic `Op::BatchCommit` so partial-pair op-log failure is
        // impossible. Expect 2 ops total: PutFormula → BatchCommit{PutValue,
        // ClearFormula}.
        assert_eq!(ops.len(), 2, "ops were: {ops:?}");
        assert!(matches!(ops[0], Op::PutFormula { .. }));
        match &ops[1] {
            Op::BatchCommit { ops: inner } => {
                assert_eq!(inner.len(), 2);
                assert!(matches!(inner[0], Op::PutValue { .. }));
                assert!(matches!(inner[1], Op::ClearFormula { .. }));
            }
            other => panic!("expected BatchCommit pair, got {other:?}"),
        }
    }

    #[test]
    fn set_value_blank_emits_nothing_when_cell_is_already_blank() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // Blank-write on a blank cell with no formula — emits no op
            // (PutValue is skipped because CellWireValue::from_value(Blank) =
            // None; ClearFormula is skipped because had_formula = false).
            rt.set_value(0, 0, 0, Value::Blank).unwrap();
        }
        assert!(
            oplog.is_empty(),
            "expected empty log, got {} ops",
            oplog.len()
        );
    }

    #[test]
    fn set_value_blank_over_formula_emits_clear_formula_only() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Seed a formula directly on the workbook (skip the op log so we
        // isolate the Blank-over-formula behaviour).
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_formula(0, 0, 0, "1 + 4");
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_value(0, 0, 0, Value::Blank).unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        assert!(matches!(ops[0], Op::ClearFormula { .. }));
    }

    #[test]
    fn set_formula_with_oplog_emits_put_formula_text_only() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            let v = rt.set_formula(0, 1, 0, "A1 * 2").unwrap();
            assert_eq!(v, Value::Number(20.0));
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::PutFormula {
                sheet,
                row,
                col,
                text,
            } => {
                assert_eq!((*sheet, *row, *col), (0, 1, 0));
                assert_eq!(text.as_str(), "A1 * 2");
            }
            other => panic!("expected PutFormula, got {other:?}"),
        }
    }

    /// **W5-103 megaudit HIGH-3 closure** — oplog must record the
    /// PutFormula even when set_formula triggers J.5 host-spill
    /// dissolution. The new ordering (op-log append BEFORE clear_spill)
    /// is what guarantees workbook/log consistency on failure; the
    /// happy path here pins that the op IS recorded for the spill-target
    /// case.
    #[test]
    fn set_formula_into_spill_target_emits_put_formula_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // Anchor A1 spills 1×3. Records ONE PutFormula.
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
            // Write a formula at B1 (a spill target) — J.5 dissolves
            // A1's spill. Records the SECOND PutFormula.
            rt.set_formula(0, 0, 1, "99").unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // Exactly 2 PutFormula ops — host-spill dissolution does NOT
        // emit a third op (no Op::ClearFormula at the host anchor).
        assert_eq!(
            ops.len(),
            2,
            "two set_formula calls produce exactly two PutFormula ops"
        );
        for op in &ops {
            assert!(
                matches!(op, Op::PutFormula { .. }),
                "all ops are PutFormula, got {op:?}"
            );
        }
        // Specifically verify the second op's payload.
        match &ops[1] {
            Op::PutFormula {
                sheet,
                row,
                col,
                text,
            } => {
                assert_eq!((*sheet, *row, *col), (0, 0, 1));
                assert_eq!(text.as_str(), "99");
            }
            other => panic!("expected PutFormula for B1, got {other:?}"),
        }
    }

    /// **W5-103 megaudit HIGH-3 closure** — re-setting an array formula
    /// at the same anchor (J.2 clear-old path) records exactly ONE
    /// PutFormula per call. The op-log emission happens BEFORE the
    /// clear-old mutation; the clear is a workbook-internal side
    /// effect that does NOT show up as a separate op.
    #[test]
    fn set_formula_array_reshape_records_one_op_per_call() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap(); // 1x3
            rt.set_formula(0, 0, 0, "{4; 5}").unwrap(); // reshape to 2x1
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 2, "two set_formula calls → exactly two ops");
    }

    #[test]
    fn set_formula_lex_error_does_not_emit_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // **W5-143 (Phase 4.9.G):** `@` is now the implicit-
            // intersection operator. Backtick is still rejected by
            // the lexer as unexpected char.
            let result = rt.set_formula(0, 0, 0, "`foo");
            assert!(matches!(result, Err(RuntimeError::Lex(_))));
        }
        assert!(
            oplog.is_empty(),
            "lex error must not append; got {} ops",
            oplog.len()
        );
    }

    #[test]
    fn set_formula_parse_error_does_not_emit_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            let result = rt.set_formula(0, 0, 0, "(1 + 2");
            assert!(matches!(result, Err(RuntimeError::Parse(_))));
        }
        assert!(oplog.is_empty());
    }

    #[test]
    fn set_formula_invalid_cell_does_not_emit_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            let result = rt.set_formula(99, 0, 0, "1 + 1");
            assert!(matches!(result, Err(RuntimeError::InvalidSheet { .. })));
        }
        assert!(oplog.is_empty());
    }

    #[test]
    fn recompute_all_does_not_emit_ops() {
        // recompute_all is idempotent re-evaluation; it shouldn't show up in
        // the op log as a producer mutation. (The op log records user-intent
        // edits, not derived recomputes.)
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Seed via the runtime so 2 ops land (1 PutValue + 1 PutFormula);
        // then recompute_all must not add more.
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_value(0, 0, 0, Value::Number(2.0)).unwrap();
            rt.set_formula(0, 1, 0, "A1 * 3").unwrap();
        }
        let len_before_recompute = oplog.len();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            let result = rt.recompute_all();
            assert!(result.is_complete());
        }
        assert_eq!(
            oplog.len(),
            len_before_recompute,
            "recompute_all must not append ops"
        );
        assert_eq!(len_before_recompute, 2);
    }

    #[test]
    fn runtime_without_oplog_set_value_and_set_formula_still_work() {
        // Regression guard for the existing public API.
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
        let v = rt.set_formula(0, 1, 0, "A1 + 10").unwrap();
        assert_eq!(v, Value::Number(15.0));
    }

    // ===== Tier C1 (2026-05-18) — Phase 4.12 Opus-B H-2 closure =====

    /// `recompute_all` (no session attached — the `.qbook` load / replay
    /// path) must detect cycles and emit `#CIRC!` for cycled cells.
    /// Before this fix, a self-referential formula like `A1 = A1 + 1`
    /// silently produced 1, then 2, then 3, … on successive calls
    /// because HashMap-order evaluation just re-read the prior value.
    #[test]
    fn recompute_all_emits_circ_for_self_referential_a1_plus_one() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        wb.put_formula(0, 0, 0, "A1 + 1");
        let (attempted, succeeded, failed_count) = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let r = rt.recompute_all();
            // Repeated calls stay at #CIRC! — they don't drift.
            let _ = rt.recompute_all();
            (r.attempted, r.succeeded, r.failures.len())
        };
        // Cycled cells contribute to attempted but not succeeded.
        assert_eq!(attempted, 1);
        assert_eq!(succeeded, 0);
        assert_eq!(failed_count, 0);
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Error(ErrorValue::Circ),
            "self-referential A1 = A1+1 must resolve to #CIRC!, not a stale incremented value"
        );
    }

    /// 2-cycle: A1 = B1 + 1, B1 = A1 - 1. Both cells in the SCC must
    /// resolve to `#CIRC!`. Mirrors the existing `recompute_dirty`
    /// reference test (`recompute_dirty_writes_circ_error_for_cycle_members`).
    #[test]
    fn recompute_all_emits_circ_for_two_cycle_a1_b1() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        wb.put_formula(0, 0, 0, "B1 + 1");
        wb.put_formula(0, 0, 1, "A1 - 1");
        let (attempted, succeeded, failed_count) = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let r = rt.recompute_all();
            (r.attempted, r.succeeded, r.failures.len())
        };
        assert_eq!(attempted, 2);
        assert_eq!(succeeded, 0);
        assert_eq!(failed_count, 0);
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Error(ErrorValue::Circ),
            "A1 in 2-cycle must be #CIRC!"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::Circ),
            "B1 in 2-cycle must be #CIRC!"
        );
    }

    /// Acyclic mix with a cycle: A1 = 5, B1 = A1 * 2, C1 = C1 + 1
    /// (self-referential). A1 and B1 evaluate normally; C1 emits
    /// `#CIRC!`. Verifies cycle detection doesn't pollute the
    /// acyclic remainder.
    #[test]
    fn recompute_all_isolates_cycle_from_acyclic_formulas() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_formula(0, 0, 1, "A1 * 2");
        wb.put_formula(0, 0, 2, "C1 + 1");
        let (attempted, succeeded, failed_count) = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let r = rt.recompute_all();
            (r.attempted, r.succeeded, r.failures.len())
        };
        assert_eq!(attempted, 2, "B1 + C1 are the formulas");
        assert_eq!(succeeded, 1, "B1 evaluates; C1 is cycled");
        assert_eq!(failed_count, 0);
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(10.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 2)),
            Value::Error(ErrorValue::Circ)
        );
    }

    /// Cycle value must be stable across repeated `recompute_all`
    /// calls — no drift between iterations. Before this fix, A1 in
    /// `A1 = A1 + 1` returned 1, 2, 3, … instead of #CIRC! each time.
    #[test]
    fn recompute_all_repeated_calls_are_idempotent_on_cycle() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        wb.put_formula(0, 0, 0, "A1 + 1");
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            for _ in 0..5 {
                rt.recompute_all();
            }
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Error(ErrorValue::Circ),
            "cycle value must remain #CIRC! across repeated recompute_all calls (no drift)"
        );
    }

    /// **Tier C1 audit Codex H-1 closure:** a non-cycled dependent
    /// of a cycled cell must propagate `#CIRC!`, not read the
    /// cycled cell's stale prior value. Before the pre-pass fix,
    /// HashMap-order could evaluate B1 (=A1+1) before A1's `#CIRC!`
    /// was written, so B1 would compute `prior(A1) + 1`. With the
    /// pre-pass, A1 is `#CIRC!` before any non-cycled eval runs,
    /// so B1 sees the error sigil and propagates it.
    #[test]
    fn recompute_all_dependent_of_cycle_propagates_circ_error() {
        // Seed A1 with a non-cycle prior value to make the test
        // hostile to the lazy-write bug: if the bug were still
        // present, B1 might read `A1=42` and write 43 to B1
        // instead of `#CIRC!`.
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        wb.put_at(0, 0, 0, Value::Number(42.0));
        wb.put_formula(0, 0, 0, "A1 + 1");
        wb.put_formula(0, 0, 1, "A1 + 1");
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.recompute_all();
        }
        // A1 is cycled → #CIRC!.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Error(ErrorValue::Circ),
            "self-referential A1 must be #CIRC!"
        );
        // B1 is non-cycled but reads A1 — must propagate #CIRC!.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::Circ),
            "B1 reads cycled A1 and must propagate #CIRC!, not the stale prior value 42"
        );
    }

    /// **Tier C1 audit Codex H-2 closure:** if a previously-spilling
    /// anchor (e.g. `A1 = SEQUENCE(3)`) gets overwritten with a
    /// circular formula, the old spill must be cleared so stale
    /// targets A2/A3 don't survive next to the `#CIRC!` anchor.
    #[test]
    fn recompute_all_clears_stale_spill_when_anchor_becomes_circular() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        wb.put_formula(0, 0, 0, "SEQUENCE(3)");
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.recompute_all();
        }
        // After first recompute: A1 spilled to A1:A3.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Number(1.0),
            "A1 anchor spill body[0]"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 1, 0)),
            Value::Number(2.0),
            "A2 spill body[1]"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 2, 0)),
            Value::Number(3.0),
            "A3 spill body[2]"
        );
        assert!(
            wb.spill_anchor_at(0, 0, 0).is_some(),
            "spill anchor registered at A1"
        );

        // Overwrite A1 with a circular formula. `put_formula` goes
        // through the workbook directly (bypassing the runtime's
        // spill-aware set_formula); this mimics the `.qbook` load /
        // replay scenario where formula text arrives without the
        // runtime spill-cleanup pipeline.
        wb.put_formula(0, 0, 0, "A1 + 1");
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.recompute_all();
        }
        // A1 becomes #CIRC!.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Error(ErrorValue::Circ),
            "A1 now circular → #CIRC!"
        );
        // Old spill anchor must be cleared.
        assert!(
            wb.spill_anchor_at(0, 0, 0).is_none(),
            "stale spill anchor at A1 must be cleared when A1 becomes circular"
        );
        // Stale spill targets in A2, A3 must be cleared too (the
        // spill body lived in the computed overlay; clearing the
        // anchor unwinds the body).
        assert_eq!(
            wb.read(ql_types::Address::new(0, 1, 0)),
            Value::Blank,
            "A2 must not retain stale spill body value 2"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 2, 0)),
            Value::Blank,
            "A3 must not retain stale spill body value 3"
        );
    }

    // ===== Phase 2B.2 — RecomputeResult contract =====

    /// R2B-01: a structural failure surfaces with the exact cell address +
    /// formula text + underlying RuntimeError. No information is lost going
    /// from "failed cell" to "RecomputeFailure entry".
    #[test]
    fn recompute_all_failure_carries_exact_cell_and_formula_text() {
        let mut wb = make_runtime_workbook();
        // Seed an unparseable formula by hand-writing it into the workbook
        // (bypassing the runtime's set_formula which would reject it
        // up-front). This simulates the on-disk-corruption scenario the
        // loader handles.
        wb.put_formula(0, 3, 5, "(((");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert!(!result.is_complete());
        assert_eq!(result.failed_count(), 1);
        let failure = &result.failures[0];
        assert_eq!(failure.sheet, 0);
        assert_eq!(failure.row, 3);
        assert_eq!(failure.col, 5);
        assert_eq!(failure.formula_text.as_ref(), "(((");
        // Underlying error is a parse error (unclosed paren).
        assert!(
            matches!(failure.error, RuntimeError::Parse(_)),
            "expected Parse error, got {:?}",
            failure.error
        );
    }

    /// R2B-02: a failure does not short-circuit. Cells whose formulas DO
    /// parse cleanly get re-evaluated and counted as succeeded, regardless
    /// of iteration order.
    #[test]
    fn recompute_all_does_not_short_circuit_on_first_failure() {
        let mut wb = make_runtime_workbook();
        // 3 good formulas + 2 bad ones. We don't know iteration order, but
        // we know exactly 3 should succeed and exactly 2 should fail.
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_formula(0, 1, 0, "A1 + 1"); // good
        wb.put_formula(0, 2, 0, "A1 * 2"); // good
        wb.put_formula(0, 3, 0, "A1 - 5"); // good
        wb.put_formula(0, 4, 0, "((("); // parse error
        wb.put_formula(0, 5, 0, "@bogus"); // lex error

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.attempted, 5);
        assert_eq!(result.succeeded, 3);
        assert_eq!(result.failed_count(), 2);
        assert!(!result.is_complete());

        // Good cells were updated regardless of order.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 1, 0)),
            Value::Number(11.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 2, 0)),
            Value::Number(20.0)
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 3, 0)), Value::Number(5.0));
    }

    /// R2B-03: invalid persisted formulas do NOT panic the runtime. Every
    /// kind of structural failure (lex / parse / bind) surfaces as a
    /// `RecomputeFailure` entry; the runtime stays alive.
    #[test]
    fn recompute_all_does_not_panic_on_invalid_persisted_formulas() {
        let mut wb = make_runtime_workbook();
        wb.put_formula(0, 0, 0, "@@@"); // lex error
        wb.put_formula(0, 0, 1, "1 +"); // parse error (trailing operator)
        wb.put_formula(0, 0, 2, "UnknownName + 1"); // bind error (UnresolvedName)

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Just calling this must not panic — the assertion is the absence
        // of a panic, plus the structural-failure invariant.
        let result = rt.recompute_all();
        assert_eq!(result.attempted, 3);
        assert_eq!(result.succeeded, 0);
        assert_eq!(result.failed_count(), 3);
        assert!(!result.is_complete());
    }

    /// Evaluation-time errors (Value::Error variants like #DIV/0!) count as
    /// SUCCEEDED, not failed. Recompute writes the error value to the cell
    /// per Excel canon. Only structural failures (lex/parse/bind) populate
    /// `RecomputeResult::failures`.
    #[test]
    fn recompute_all_eval_time_error_values_count_as_succeeded() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_formula(0, 1, 0, "A1 / 0"); // evaluates to #DIV/0!

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.succeeded, 1);
        assert_eq!(result.failed_count(), 0);
        assert!(result.is_complete());
        // The cell value is the error sentinel, written by put_at.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 1, 0)),
            Value::Error(ErrorValue::DivZero)
        );
    }

    /// Failed cells keep their pre-recompute values; their formula text is
    /// preserved (recompute never clears formula on failure).
    #[test]
    fn recompute_all_failed_cells_preserve_prior_state() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(999.0)); // pre-recompute value
        wb.put_formula(0, 0, 0, "(((");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.failed_count(), 1);
        // Cell value untouched by failed recompute.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Number(999.0)
        );
        // Formula text still on disk.
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("((("));
    }

    // ===== Phase 2B.3 — bind-plan cache =====

    /// BPC-01: repeated `recompute_all` against the same workbook does NOT
    /// re-lex / re-parse / re-bind unchanged formulas. The second pass
    /// hits the cache for every formula.
    #[test]
    fn recompute_all_second_pass_is_all_cache_hits() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_formula(0, 1, 0, "A1 + 1");
        wb.put_formula(0, 2, 0, "A1 * 2");
        wb.put_formula(0, 3, 0, "A1 - 3");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // First pass: 3 misses (one per formula).
        let r1 = rt.recompute_all();
        assert_eq!(r1.succeeded, 3);
        let s1 = rt.cache_stats();
        assert_eq!(s1.misses, 3);
        assert_eq!(s1.hits, 0);
        assert_eq!(s1.entries, 3);

        // Second pass: 3 hits (the cache covers every formula). The
        // miss count does not change.
        let r2 = rt.recompute_all();
        assert_eq!(r2.succeeded, 3);
        let s2 = rt.cache_stats();
        assert_eq!(s2.misses, 3, "no new misses on the second pass");
        assert_eq!(s2.hits, 3, "every formula hit the cache");
    }

    /// BPC-02: a NameTable mutation between recompute_all calls invalidates
    /// every cached plan (because the cache key includes the generation).
    /// The next recompute_all is all misses.
    #[test]
    fn name_table_mutation_invalidates_bind_plan_cache() {
        use ql_storage::NamedTarget;
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_formula(0, 1, 0, "A1 + 1");
        wb.put_formula(0, 2, 0, "A1 * 2");

        let reg = default_registry();

        // First runtime pass: 2 misses, then the runtime drops so we can
        // mutate the name table.
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let _ = rt.recompute_all();
            assert_eq!(rt.cache_stats().misses, 2);
            assert_eq!(rt.cache_stats().hits, 0);
        }

        // Mutate name table (bumps generation).
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();

        // New runtime: cache is empty (per-runtime cache), so still misses;
        // but the IMPORTANT invariant is that a subsequent in-runtime
        // recompute against a CHANGED name table also misses for cached
        // entries with the old generation. Test that next:
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Pass A — warms the cache at the current (post-mutation) gen.
        let _ = rt.recompute_all();
        let stats_a = rt.cache_stats();
        assert_eq!(stats_a.misses, 2);

        // Mutate again INSIDE this runtime's lifetime.
        let old_gen = wb.names().generation();
        wb.set_name("ExtraName", NamedTarget::Constant(Value::Number(1.0)))
            .unwrap();
        assert!(
            wb.names().generation() > old_gen,
            "generation must bump on set"
        );

        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Pass B — all formulas miss again because keys differ on
        // name_gen. Were the cache key gen-blind, this would hit and the
        // invalidation contract would be broken.
        let _ = rt.recompute_all();
        let stats_b = rt.cache_stats();
        assert_eq!(
            stats_b.misses, 2,
            "name table mutation must invalidate cached plans"
        );
        assert_eq!(stats_b.hits, 0);
    }

    /// BPC-03: cache keys are stable across recompute_all calls — same
    /// formula text + same sheet + same name_gen always hashes to the
    /// same key, so hits are reliable. This is structural (Hash/Eq on
    /// PlanCacheKey) but we exercise it end-to-end through the runtime.
    #[test]
    fn cache_keys_are_stable_across_recompute_passes() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(7.0));
        wb.put_formula(0, 1, 0, "A1 + 1");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // 10 successive recomputes against the same state.
        for i in 0..10 {
            let _ = rt.recompute_all();
            let stats = rt.cache_stats();
            // Exactly 1 miss total (first pass); the other 9 are hits.
            assert_eq!(stats.misses, 1, "iteration {i}: unexpected new miss");
            assert_eq!(stats.hits, i, "iteration {i}: hit count off");
        }
    }

    /// BPC-04: cache hit/miss counters are visible (via `cache_stats()`)
    /// in a form that ql-profile can lift into `Timings`. The
    /// counterpart `Timings::bind_plan_cache_hits/misses` fields exist
    /// and accept these numbers verbatim.
    #[test]
    fn cache_stats_flow_into_timings_struct() {
        use ql_profile::Timings;
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_formula(0, 1, 0, "A1 + 100");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let _ = rt.recompute_all(); // 1 miss
        let _ = rt.recompute_all(); // 1 hit

        let s = rt.cache_stats();
        let mut timings = Timings::new();
        timings.bind_plan_cache_hits = s.hits;
        timings.bind_plan_cache_misses = s.misses;
        assert_eq!(timings.bind_plan_cache_hits, 1);
        assert_eq!(timings.bind_plan_cache_misses, 1);
        assert_eq!(timings.bind_plan_cache_hit_rate(), Some(0.5));
    }

    /// `set_formula` pre-warms the cache. A subsequent `recompute_all`
    /// of the same cell hits the cache (no re-bind work).
    #[test]
    fn set_formula_populates_cache_for_subsequent_recompute() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(2.0));

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 1, 0, "A1 * 50").unwrap();
        let after_set = rt.cache_stats();
        assert_eq!(after_set.misses, 1);
        assert_eq!(after_set.hits, 0);
        assert_eq!(after_set.entries, 1);

        // Recompute the workbook — should hit the cache for the formula
        // we just set.
        let _ = rt.recompute_all();
        let after_recompute = rt.cache_stats();
        assert_eq!(after_recompute.misses, 1, "no new misses");
        assert_eq!(after_recompute.hits, 1, "recompute hit the cache");
    }

    // ===== Phase 2B.4 — named-range aggregate context prep =====

    /// NAG-01: named CONSTANTS continue to work after the binder grows
    /// context-awareness. Regression guard against accidentally breaking
    /// the existing Constant resolution path. Uses a long unambiguous name
    /// to avoid the parser's column-letter heuristic (short names like
    /// `Pi` collide with column-pair syntax).
    #[test]
    fn nag_01_named_constants_still_work_in_scalar_and_aggregate_contexts() {
        use ql_storage::NamedTarget;
        let mut wb = make_runtime_workbook();
        // Pick 0.42 (not an approximation of any math constant, so
        // clippy's `approx_constant` lint stays quiet — earlier the test
        // used 3.14 / 6.28 which clippy flagged as ≈ π / τ).
        wb.set_name("MyConstant", NamedTarget::Constant(Value::Number(0.42)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Scalar position.
        let v_scalar = rt.set_formula(0, 0, 0, "MyConstant * 2").unwrap();
        assert_eq!(v_scalar, Value::Number(0.84));

        // Aggregate position.
        let v_aggregate = rt
            .set_formula(0, 0, 1, "SUM(MyConstant, MyConstant, MyConstant)")
            .unwrap();
        assert!(matches!(v_aggregate, Value::Number(n) if (n - 1.26).abs() < 1e-9));
    }

    /// NAG-02: named CELL REFERENCES continue to work after the binder
    /// grows context-awareness.
    #[test]
    fn nag_02_named_cell_references_still_work() {
        use ql_storage::NamedTarget;
        use ql_types::Address;
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(42.0));
        wb.set_name("MyRef", NamedTarget::Cell(Address::new(0, 0, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Scalar position.
        let v_scalar = rt.set_formula(0, 1, 0, "MyRef + 8").unwrap();
        assert_eq!(v_scalar, Value::Number(50.0));

        // Aggregate position — a named cell ref inside SUM is fine; it
        // resolves as a single cell, not as a range.
        let v_aggregate = rt.set_formula(0, 1, 1, "SUM(MyRef, MyRef)").unwrap();
        assert_eq!(v_aggregate, Value::Number(84.0));
    }

    /// NAG-03: a named RANGE inside an aggregate function binds to the
    /// explicit `ExprPlan::AggregateNameRef` variant (rather than producing
    /// a bind error). Phase 3.6 (W5-39, 2026-05-12) wired aggregate-range
    /// eval, so the cell value is now the actual SUM (not `#CALC!`). The
    /// range here covers A2:A11 (no values populated) → SUM = 0.
    #[test]
    fn nag_03_named_range_in_aggregate_function_binds_to_explicit_variant() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // SUM(Sales) — Phase 3.6: actual evaluation. Empty range sums to 0.
        let v = rt.set_formula(0, 0, 0, "SUM(Sales)").unwrap();
        assert_eq!(v, Value::Number(0.0));
        // Formula text canonicalized through W5-147's lex→parse→print
        // pipeline. NameRef "Sales" uppercases to "SALES" per parser
        // Excel canon.
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("SUM(SALES)")
        );
    }

    /// NAG-04: a named RANGE in scalar context produces the precise
    /// `NamedRangeInScalarContext` error, not the generic `UnsupportedVariant`.
    /// (The pre-existing `set_formula_named_range_in_scalar_context_errors`
    /// test covers a single shape; this one exercises a few more positions.)
    #[test]
    fn nag_04_named_range_in_scalar_positions_errors_precisely() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.set_name("Block", NamedTarget::Range(Range::new(0, 0, 0, 5, 5)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Bare reference.
        match rt.set_formula(0, 0, 0, "Block") {
            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
                assert_eq!(n.as_ref(), "BLOCK");
            }
            other => panic!("expected NamedRangeInScalarContext, got {other:?}"),
        }

        // Inside arithmetic.
        match rt.set_formula(0, 0, 1, "Block + 1") {
            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
                assert_eq!(n.as_ref(), "BLOCK");
            }
            other => panic!("expected NamedRangeInScalarContext, got {other:?}"),
        }

        // Inside a NON-aggregate function (IF) — args are scalar context.
        match rt.set_formula(0, 0, 2, "IF(TRUE, Block, 0)") {
            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
                assert_eq!(n.as_ref(), "BLOCK");
            }
            other => panic!("expected NamedRangeInScalarContext inside IF, got {other:?}"),
        }
    }

    /// Named formulas (NamedTarget::Formula) surface a distinct
    /// `NamedFormulaUnsupported` error rather than the generic
    /// `UnsupportedVariant`. Engine Phase 4 will implement them.
    #[test]
    fn named_formula_surfaces_distinct_bind_error() {
        use ql_storage::NamedTarget;
        let mut wb = make_runtime_workbook();
        wb.names_mut()
            .set(
                "Profit",
                NamedTarget::Formula(std::sync::Arc::from("Revenue - Costs")),
            )
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        match rt.set_formula(0, 0, 0, "Profit") {
            Err(RuntimeError::Bind(BindError::NamedFormulaUnsupported(n))) => {
                assert_eq!(n.as_ref(), "PROFIT");
            }
            other => panic!("expected NamedFormulaUnsupported, got {other:?}"),
        }
    }

    // ===== Phase 2B.7 — audit closure: input validation + dry-run + cleanup =====

    /// Phase 2B.7 audit H1: `add_sheet` rejects `chunk_rows == 0` BEFORE
    /// any op-log append. Without this check, the workbook gets a sheet
    /// with `chunk_rows = 0` and the first cell write panics inside the
    /// column store — and the op log has a phantom AddSheet entry that
    /// would replay the same poison state on next load.
    #[test]
    fn add_sheet_rejects_zero_chunk_rows() {
        use ql_oplog::OpLog;
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let result = {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.add_sheet("Bad", 0)
        };
        match result {
            Err(RuntimeError::InvalidChunkRows(0)) => {}
            other => panic!("expected InvalidChunkRows(0), got {other:?}"),
        }
        // No sheet added; no op-log entry.
        assert_eq!(wb.sheet_count(), 0);
        assert!(
            oplog.is_empty(),
            "op log must stay empty on validation failure"
        );
    }

    /// Phase 2B.7 audit (correctness L4): `clear_formula` propagates
    /// `RuntimeError::InvalidSheet` / `InvalidCell` from `validate_cell`.
    #[test]
    fn clear_formula_rejects_invalid_sheet() {
        let mut wb = make_runtime_workbook(); // 1 sheet
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.clear_formula(99, 0, 0);
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidSheet {
                    sheet: 99,
                    sheet_count: 1
                })
            ),
            "expected InvalidSheet, got {result:?}"
        );
    }

    #[test]
    fn clear_formula_rejects_invalid_cell() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.clear_formula(0, 1_048_576, 0);
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidCell { row: 1_048_576, .. })
            ),
            "expected InvalidCell, got {result:?}"
        );
    }

    /// Phase 2B.7 (closes GAP-I-04): `validate_formula` runs the full
    /// pipeline but doesn't mutate the workbook or the op log. The IDE
    /// can call it on every keystroke to surface diagnostics without
    /// committing the user's draft.
    #[test]
    fn validate_formula_returns_value_without_writing() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        use ql_oplog::OpLog;
        let mut oplog = OpLog::new();
        let rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

        let v = rt.validate_formula(0, 1, 0, "A1 * 5").unwrap();
        assert_eq!(v, Value::Number(50.0));

        // Workbook UNCHANGED: cell (1, 0) is still Blank, no formula
        // associated.
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Blank);
        assert!(wb.formula_at(0, 1, 0).is_none());
        // Op log untouched.
        assert!(oplog.is_empty());
    }

    /// `validate_formula` surfaces bind errors the same way `set_formula`
    /// does — the IDE renders the same Display strings.
    #[test]
    fn validate_formula_surfaces_bind_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.validate_formula(0, 0, 0, "(1 + 2");
        assert!(matches!(result, Err(RuntimeError::Parse(_))));
        // No state change.
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// **W5-103 megaudit MEDIUM-3 closure (#129):** `validate_formula`
    /// on a top-level array literal must return the anchor value
    /// (array.at(0,0)), NOT `#CALC!`. Pre-fix the scalar-context
    /// `eval_scalar_with_registry` path gave #CALC! for arrays,
    /// making the IDE preview inconsistent with `set_formula`'s
    /// actual spill behavior.
    #[test]
    fn validate_formula_returns_anchor_value_for_top_level_array() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let rt = WorkbookRuntime::new(&mut wb, &reg);
        // Horizontal: {1, 2, 3} — anchor is array.at(0,0) = Number(1).
        let v = rt.validate_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        assert_eq!(
            v,
            Value::Number(1.0),
            "validate_formula on array literal must give anchor value"
        );
        // Vertical: {7; 8} — anchor is Number(7).
        let v = rt.validate_formula(0, 0, 0, "{7; 8}").unwrap();
        assert_eq!(v, Value::Number(7.0));
        // 2x2: {1, 2; 3, 4} — anchor is Number(1).
        let v = rt.validate_formula(0, 0, 0, "{1, 2; 3, 4}").unwrap();
        assert_eq!(v, Value::Number(1.0));
        // No state mutation (validate is read-only).
        assert!(wb.formula_at(0, 0, 0).is_none());
        assert!(wb.spill_anchor_at(0, 0, 0).is_none());
    }

    /// `validate_formula` does NOT pollute the bind-plan cache. A
    /// keystroke-driven validate of a half-typed formula must not insert
    /// a cache entry that would mismatch when the user finally hits Enter.
    #[test]
    fn validate_formula_does_not_pollute_plan_cache() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(2.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Validate several drafts. The cache stays empty.
        let _ = rt.validate_formula(0, 1, 0, "A1 + 1").unwrap();
        let _ = rt.validate_formula(0, 1, 0, "A1 + 2").unwrap();
        let _ = rt.validate_formula(0, 1, 0, "A1 + 3").unwrap();
        assert_eq!(rt.cache_stats().entries, 0);
        assert_eq!(rt.cache_stats().hits, 0);
        assert_eq!(rt.cache_stats().misses, 0);

        // A real set_formula DOES populate the cache.
        rt.set_formula(0, 1, 0, "A1 + 3").unwrap();
        assert_eq!(rt.cache_stats().entries, 1);
    }

    /// Phase 2B.7 audit (correctness M1): `is_aggregate_function` must
    /// only list functions actually registered. Cross-check against the
    /// default registry; a mismatch means the binder will surface
    /// `NamedRangeInScalarContext` for what looked like a valid aggregate
    /// (or vice versa).
    #[test]
    fn is_aggregate_function_lists_only_registered_aggregates() {
        let reg = default_registry();
        // Every name `is_aggregate_function` recognizes must exist in the
        // registry. Hardcoded names (mirror the matcher in plan.rs).
        for name in &[
            "SUM", "AVERAGE", "AVG", "COUNT", "COUNTA", "MIN", "MAX", "PRODUCT", "VAR", "VAR.S",
            "VAR.P", "STDEV", "STDEV.S", "STDEV.P",
        ] {
            assert!(
                reg.lookup(name).is_some(),
                "is_aggregate_function lists {name:?} but it's not in default_registry"
            );
        }
        // W5-53 (GAP-F-05 closure) + W5-54 (lookup family): range-
        // aware names are also in is_aggregate_function but live in
        // the parallel range_aware_fns table; check via
        // lookup_range_aware.
        for name in &[
            "SUMIF",
            "COUNTIF",
            "MATCH",
            "INDEX",
            "VLOOKUP",
            "HLOOKUP",
            "CHOOSE",
            "AVERAGEIF",
            "SUMIFS",
            "COUNTIFS",
            "AVERAGEIFS",
            "SUMPRODUCT",
            "LARGE",
            "SMALL",
            "RANK",
            "RANK.EQ",
            // W5-62 audit closure (Codex M2 / Sonnet H1): the
            // invariant test had drifted out of sync with the
            // is_aggregate_function whitelist. RANK.AVG + CONCAT
            // landed W5-61 but weren't pinned here.
            "RANK.AVG",
            "MEDIAN",
            "MODE",
            "MODE.SNGL",
            "CONCAT",
            // **W5-D-12 (Phase 4.10 V1-260 sealer) — Codex HIGH-001
            // closure:** SUBTOTAL is range-aware (dispatches to scalar
            // aggregates based on function_num) and admitted to
            // is_aggregate_function so range args bind as
            // AggregateNameRef. Eval-side routes via lookup_range_aware.
            "SUBTOTAL",
            // **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure):**
            // 28 additional range-aware fns admitted to
            // is_aggregate_function in one batch — the same systemic
            // gap the W5-D-12 closure caught only for SUBTOTAL. Per
            // megaudit Codex HIGH-001 + Opus HIGH-1.
            "CORREL",
            "PEARSON",
            "RSQ",
            "STEYX",
            "SLOPE",
            "INTERCEPT",
            "COVARIANCE.P",
            "COVARIANCE.S",
            "SUMX2MY2",
            "SUMX2PY2",
            "SUMXMY2",
            "NPV",
            "IRR",
            "MIRR",
            "XNPV",
            "XIRR",
            "XLOOKUP",
            "XMATCH",
            "PERCENTILE.INC",
            "PERCENTILE.EXC",
            "PERCENTILE",
            "QUARTILE.INC",
            "QUARTILE.EXC",
            "QUARTILE",
            "MINIFS",
            "MAXIFS",
            "COUNTBLANK",
            "TEXTJOIN",
        ] {
            assert!(
                reg.lookup_range_aware(name).is_some(),
                "is_aggregate_function lists {name:?} (range-aware variant) but \
                 it's not in default_registry's range_aware_fns table"
            );
            assert!(
                reg.lookup(name).is_none(),
                "{name:?} is range-aware ONLY; must not also appear in the scalar table"
            );
        }
        // W5-107-AUDIT (Phase 4.7.N — Codex HIGH closure): unified-ABI
        // array-returning functions that also appear in
        // is_aggregate_function so the binder routes named-range args
        // through Range context instead of surfacing
        // NamedRangeInScalarContext. They live in unified_fns, not
        // scalar/range_aware tables.
        for name in &["TRANSPOSE", "FILTER"] {
            assert!(
                reg.lookup_unified(name).is_some(),
                "is_aggregate_function lists {name:?} (unified variant) but \
                 it's not in default_registry's unified_fns table"
            );
            assert!(
                reg.lookup(name).is_none(),
                "{name:?} is unified ONLY; must not appear in the scalar table"
            );
            assert!(
                reg.lookup_range_aware(name).is_none(),
                "{name:?} is unified ONLY; must not appear in the range-aware table"
            );
        }
        // Sanity: a known non-aggregate (IF) is in the registry but
        // is_aggregate_function does NOT claim it. We can't directly call
        // is_aggregate_function (private), but we can verify via behavior:
        // a NameRef to a range used inside IF surfaces
        // NamedRangeInScalarContext (since IF's args are scalar context).
        // That behaviour is pinned by `nag_04_named_range_in_scalar_positions_errors_precisely`.
    }

    /// **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex HIGH-001,
    /// Opus HIGH-1 / HIGH-3):** prove that the 28 range-aware fns
    /// admitted to `is_aggregate_function` in this closure actually
    /// route range args through `AggregateNameRef` end-to-end, not just
    /// pass the registry-lookup smoke test. This is the e2e armor the
    /// W5-D-12 SUBTOTAL closure should have had but didn't, scaled to
    /// cover the systemic case.
    ///
    /// Each test sets up a named range, then drives a formula through
    /// `set_formula` (which exercises lex → parse → bind → eval). A
    /// pre-W5-D-13.1 build would fail every one of these with
    /// `Bind(NamedRangeInScalarContext("SALES"))`.
    #[test]
    fn w5_d_13_1_subtotal_named_range_binds_and_evaluates() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_at(0, 1, 0, Value::Number(2.0));
        wb.put_at(0, 2, 0, Value::Number(3.0));
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 0, 0, 2, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // SUBTOTAL(9, Sales) = SUM(Sales) = 6. The Codex W5-D-12
        // HIGH-001 closure recommendation that was never shipped.
        let v = rt.set_formula(0, 5, 0, "SUBTOTAL(9, Sales)").unwrap();
        assert_eq!(v, Value::Number(6.0));
        // SUBTOTAL(1, Sales) = AVERAGE(Sales) = 2.
        let v = rt.set_formula(0, 5, 1, "SUBTOTAL(1, Sales)").unwrap();
        assert_eq!(v, Value::Number(2.0));
    }

    #[test]
    fn w5_d_13_1_percentile_quartile_named_range_binds_and_evaluates() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        for i in 0..4 {
            wb.put_at(0, i as u32, 0, Value::Number((i + 1) as f64));
        }
        wb.set_name("Data", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // PERCENTILE.INC(Data, 0.3) = 1.9 (Microsoft anchor).
        let v = rt
            .set_formula(0, 5, 0, "PERCENTILE.INC(Data, 0.3)")
            .unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.9).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(1.9), got {other:?}"),
        }
        // PERCENTILE.EXC(Data, 0.25) = 1.25.
        let v = rt
            .set_formula(0, 5, 1, "PERCENTILE.EXC(Data, 0.25)")
            .unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.25).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(1.25), got {other:?}"),
        }
        // QUARTILE.INC(Data, 2) = median = 2.5.
        let v = rt.set_formula(0, 5, 2, "QUARTILE.INC(Data, 2)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 2.5).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(2.5), got {other:?}"),
        }
        // Legacy alias PERCENTILE (Excel 2010+) matches .INC.
        let v = rt.set_formula(0, 5, 3, "PERCENTILE(Data, 0.3)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.9).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(1.9), got {other:?}"),
        }
    }

    #[test]
    fn w5_d_13_1_paired_array_stats_named_range_binds_and_evaluates() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        // X = [1, 2, 3, 4]; Y = [2, 4, 6, 8] — perfect linear y=2x.
        for i in 0..4 {
            wb.put_at(0, i as u32, 0, Value::Number((i + 1) as f64));
            wb.put_at(0, i as u32, 1, Value::Number(((i + 1) * 2) as f64));
        }
        // **Note**: name must NOT collide with valid Excel column-letter
        // patterns (e.g. `Ys` lexes as BareColumn col=668). Use names
        // with >3 letters or underscores. `XValues`/`YValues` are safe.
        wb.set_name("XValues", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
            .unwrap();
        wb.set_name("YValues", NamedTarget::Range(Range::new(0, 0, 1, 3, 1)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // CORREL(YValues, XValues) = 1.0 (perfect positive correlation).
        let v = rt.set_formula(0, 5, 0, "CORREL(YValues, XValues)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(1.0), got {other:?}"),
        }
        // SLOPE(YValues, XValues) = 2.0.
        let v = rt.set_formula(0, 5, 1, "SLOPE(YValues, XValues)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 2.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(2.0), got {other:?}"),
        }
        // COVARIANCE.P(XValues, YValues) = 2.5.
        let v = rt
            .set_formula(0, 5, 2, "COVARIANCE.P(XValues, YValues)")
            .unwrap();
        match v {
            Value::Number(n) => assert!((n - 2.5).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(2.5), got {other:?}"),
        }
        // PEARSON(YValues, XValues) = 1.0 (alias of CORREL).
        let v = rt
            .set_formula(0, 5, 3, "PEARSON(YValues, XValues)")
            .unwrap();
        match v {
            Value::Number(n) => assert!((n - 1.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(1.0), got {other:?}"),
        }
    }

    #[test]
    fn w5_d_13_1_atan2_and_sumxmy2_via_source_text() {
        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex HIGH-002
        // / Opus HIGH-2):** the lexer letters>3+digit Ident-fallback
        // makes ATAN2, SUMXMY2, and DAYS360 reachable from formula
        // source text. End-to-end test via `set_formula`.
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        for i in 0..3 {
            wb.put_at(0, i as u32, 0, Value::Number((i + 1) as f64));
            wb.put_at(0, i as u32, 1, Value::Number((i + 1) as f64));
        }
        wb.set_name("XData", NamedTarget::Range(Range::new(0, 0, 0, 2, 0)))
            .unwrap();
        wb.set_name("YData", NamedTarget::Range(Range::new(0, 0, 1, 2, 1)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // ATAN2(1, 0) = 0 (angle along +x axis; Excel arg order x, y).
        let v = rt.set_formula(0, 5, 0, "ATAN2(1, 0)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 0.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(0.0), got {other:?}"),
        }
        // SUMXMY2(XData, YData) = 0 (XData == YData, so squared diffs = 0).
        let v = rt.set_formula(0, 5, 1, "SUMXMY2(XData, YData)").unwrap();
        match v {
            Value::Number(n) => assert!((n - 0.0).abs() < 1e-12, "got {n}"),
            other => panic!("expected Number(0.0), got {other:?}"),
        }
    }

    /// **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex MEDIUM-003
    /// / Opus MEDIUM-5):** the original
    /// `is_aggregate_function_lists_only_registered_aggregates` invariant
    /// pins only ONE direction (matcher → registry). The OPPOSITE
    /// direction (registry → matcher) was NEVER enforced, which is
    /// exactly why the W5-D-12 closure shipped a SUBTOTAL-only fix
    /// without anyone noticing that 28 other range-aware fns had the
    /// same admission gap.
    ///
    /// This invariant fills the gap: every range-aware-registered fn
    /// MUST be admitted by `is_aggregate_function`. Some range-aware
    /// fns may legitimately NOT need range args (none currently), so
    /// this is enforced as an allowlist of EXCEPTIONS — fns that are
    /// range-aware-registered but deliberately not admitted.
    ///
    /// If a future range-aware fn is registered with scalar-only args
    /// (no range args needed at all), it must be added to
    /// `range_aware_fns_that_do_not_need_aggregate_admission` below
    /// with a justification.
    #[test]
    fn every_range_aware_fn_is_admitted_to_is_aggregate_function() {
        use crate::plan::is_aggregate_function;
        let reg = default_registry();
        // Allowlist: range-aware fns that DO NOT need is_aggregate_function
        // admission because they don't accept range/named-range args.
        // **Empty as of W5-D-13.1** — every range-aware-registered fn
        // currently needs admission. If a future scalar-only RangeAwareFn
        // ships, it must be explicitly listed here with rationale.
        let exceptions: &[&str] = &[];

        let mut missing: Vec<&str> = Vec::new();
        for &name in reg.range_aware_names() {
            if exceptions.contains(&name) {
                continue;
            }
            if !is_aggregate_function(name) {
                missing.push(name);
            }
        }
        assert!(
            missing.is_empty(),
            "W5-D-13.1 invariant: every range-aware fn must be admitted to \
             is_aggregate_function (binder admission gate for named-range \
             args). Missing {} fns: {:?}. Fix: add them to the matcher in \
             plan.rs::is_aggregate_function, OR add to the exceptions \
             allowlist above with rationale.",
            missing.len(),
            missing
        );
    }

    /// Phase 2B.7 audit closure (test gaps #5 and #6): the existing NAG
    /// tests don't exercise nested aggregates with named ranges. Ensure
    /// `SUM(AVERAGE(Sales))` (both aggregate; inner is the named-range arg)
    /// and `ROUND(SUM(Sales), 2)` (outer scalar, inner aggregate with the
    /// named range) both bind cleanly to the appropriate plan shapes.
    #[test]
    fn nag_05_nested_aggregates_with_named_range_bind_cleanly() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // SUM(AVERAGE(Sales)) — outer SUM passes aggregate context to its
        // arg (the AVERAGE call), which in turn passes aggregate context
        // to its arg (the Sales NameRef). Both layers see aggregate
        // context; Sales binds to AggregateNameRef.
        // Phase 3.6 (W5-39): empty range. AVERAGE over empty = #DIV/0!
        // (per ql-functions::scalar_fns::average). Outer SUM propagates
        // the error.
        let v = rt.set_formula(0, 0, 0, "SUM(AVERAGE(Sales))").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::DivZero));
    }

    #[test]
    fn nag_06_round_with_nested_sum_of_named_range_binds_cleanly() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // ROUND is non-aggregate; its args bind in scalar context. The
        // FIRST arg here is SUM(Sales), which is itself a Function call —
        // recursive bind hits the SUM arm and switches to aggregate context
        // for ITS arg. Sales binds to AggregateNameRef. The outer ROUND
        // takes the SUM result + 2 in scalar context.
        // Phase 3.6 (W5-39): SUM(Sales) = 0 over empty range; ROUND(0, 2)
        // = 0.
        let v = rt.set_formula(0, 0, 0, "ROUND(SUM(Sales), 2)").unwrap();
        assert_eq!(v, Value::Number(0.0));
    }

    /// Phase 2B.7 audit (cleanup): after dropping the redundant
    /// `RecomputeResult.partial_state` pub field, `is_complete()` is the
    /// single source of truth.
    #[test]
    fn recompute_result_is_complete_is_single_source_of_truth() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_formula(0, 0, 1, "A1 + 1"); // good
        wb.put_formula(0, 0, 2, "((("); // bad

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();

        // Compile-time: no `result.partial_state` accessor exists. If a
        // future hand rolls one and exposes it as pub, this test won't
        // catch it — but the struct definition is the contract.
        assert!(!result.is_complete());
        assert_eq!(result.failed_count(), 1);
        assert_eq!(result.succeeded, 1);
        assert_eq!(result.attempted, 2);
    }

    // ===== Phase 2B.5 — op-log producer coverage =====

    /// OPL-2B-01 (part 1): `WorkbookRuntime::set_name` records `Op::SetName`
    /// in the attached op log AND registers the name in the workbook's
    /// NameTable. Without an op log, behavior is identical to
    /// `Workbook::set_name` (no recording).
    #[test]
    fn runtime_set_name_emits_op_into_attached_oplog() {
        use ql_oplog::{Op, OpLog};
        use ql_storage::NamedTarget;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
                .unwrap();
        }
        // NameTable has the new binding.
        assert!(matches!(
            wb.names().lookup_ci("TaxRate"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        // Op log has the matching Op::SetName.
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::SetName {
                scope,
                name,
                target,
            } => {
                // W5-92 (Phase 4.6.D): workbook-scoped name records scope=None.
                assert_eq!(*scope, None);
                // Op log records the canonicalized (uppercase) name.
                assert_eq!(name, "TAXRATE");
                // Wire form is NamedTargetWire::Constant for a constant target.
                assert!(matches!(target, ql_io::NamedTargetWire::Constant { .. }));
            }
            other => panic!("expected SetName, got {other:?}"),
        }
    }

    /// OPL-2B-01 (part 2): `WorkbookRuntime::add_sheet` records `Op::AddSheet`
    /// in the attached op log AND adds the sheet to the workbook. Returns
    /// the new SheetId.
    #[test]
    fn runtime_add_sheet_emits_op_into_attached_oplog() {
        use ql_oplog::{Op, OpLog};
        let mut wb = Workbook::new();
        // Pre-existing sheet 0.
        wb.add_sheet("Existing");
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let new_id = {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.add_sheet("NewSheet", 16_384).unwrap()
        };
        assert_eq!(new_id, 1);
        assert_eq!(wb.sheet_count(), 2);

        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::AddSheet { name, chunk_rows } => {
                assert_eq!(name, "NewSheet");
                assert_eq!(*chunk_rows, 16_384);
            }
            other => panic!("expected AddSheet, got {other:?}"),
        }
    }

    /// OPL-2B-01 (part 3): `WorkbookRuntime::clear_formula` records a
    /// single `Op::BatchCommit { ops: [PutValue(current), ClearFormula] }`
    /// when there was a formula to clear (so replay preserves the cell
    /// value, matching the "strip formula, keep value" semantic of
    /// `Workbook::clear_formula`). Phase 2B.7 audit H2 wraps the pair so
    /// partial-pair op-log failure is impossible. Clearing a non-formula
    /// cell is a no-op for both the workbook and the log.
    #[test]
    fn runtime_clear_formula_emits_atomic_pair_when_formula_present() {
        use ql_oplog::{Op, OpLog};
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // Seed a formula at (0, 0, 0). It evaluates to 2.
            rt.set_formula(0, 0, 0, "1 + 1").unwrap();
            // No-op clear on a different cell: no ops emitted.
            rt.clear_formula(0, 1, 0).unwrap();
            // Real clear: emits BatchCommit { [PutValue(2), ClearFormula] }.
            rt.clear_formula(0, 0, 0).unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // Expect: PutFormula (from set_formula) +
        //         BatchCommit { [PutValue(2), ClearFormula] } (the atomic pair).
        assert_eq!(ops.len(), 2, "ops were: {ops:?}");
        assert!(matches!(ops[0], Op::PutFormula { .. }));
        match &ops[1] {
            Op::BatchCommit { ops: inner } => {
                assert_eq!(inner.len(), 2);
                match &inner[0] {
                    Op::PutValue {
                        sheet,
                        row,
                        col,
                        value,
                    } => {
                        assert_eq!((*sheet, *row, *col), (0, 0, 0));
                        assert_eq!(value, &ql_io::CellWireValue::Number(2.0));
                    }
                    other => panic!("expected PutValue(2), got {other:?}"),
                }
                match &inner[1] {
                    Op::ClearFormula { sheet, row, col } => {
                        assert_eq!((*sheet, *row, *col), (0, 0, 0));
                    }
                    other => panic!("expected ClearFormula, got {other:?}"),
                }
            }
            other => panic!("expected BatchCommit pair, got {other:?}"),
        }
        // Workbook state: formula gone; value preserved at the last
        // evaluated result (2.0).
        assert!(wb.formula_at(0, 0, 0).is_none());
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(2.0));
    }

    /// OPL-2B-01 (regression): without an attached op log, the new
    /// runtime methods behave identically to the underlying Workbook
    /// methods (no panics, no errors, no recording).
    #[test]
    fn runtime_set_name_add_sheet_clear_formula_work_without_oplog() {
        use ql_storage::NamedTarget;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Long unambiguous name — short identifiers like `Foo` can collide
        // with the parser's bare-column-pair heuristic.
        rt.set_name("MyValue", NamedTarget::Constant(Value::Number(7.0)))
            .unwrap();
        let id = rt.add_sheet("AnotherSheet", 16_384).unwrap();
        assert_eq!(id, 1);

        // Set + clear a formula on the new sheet.
        rt.set_formula(id, 0, 0, "MyValue * 2").unwrap();
        rt.clear_formula(id, 0, 0).unwrap();
        // Cell value untouched by clear_formula (only the formula
        // association was removed).
        assert_eq!(
            wb.read(ql_types::Address::new(id, 0, 0)),
            Value::Number(14.0)
        );
        assert!(wb.formula_at(id, 0, 0).is_none());
    }

    /// OPL-2B-01 (reserved name): `WorkbookRuntime::set_name` propagates
    /// `NameTableError::Reserved` (per CORR-06, "AI" is reserved) AND
    /// leaves the op log untouched. The runtime uses mutate-first ordering
    /// for set_name specifically because NameTable::set has its own failure
    /// mode beyond op-log append.
    #[test]
    fn runtime_set_name_reserved_name_does_not_append_op() {
        use ql_oplog::OpLog;
        use ql_storage::NamedTarget;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let result = {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_name("AI", NamedTarget::Constant(Value::Number(0.0)))
        };
        assert!(matches!(
            result,
            Err(RuntimeError::Name(ql_storage::NameTableError::Reserved(_)))
        ));
        // Op log must be empty — no ghost entry for a rejected mutation.
        assert!(
            oplog.is_empty(),
            "rejected set_name must not leave a ghost op in the log; got {} ops",
            oplog.len()
        );
    }

    /// OPL-2B-02: producer/replay equivalence across the full op vocabulary
    /// (PutValue, PutFormula, ClearFormula, SetName, AddSheet, BatchCommit).
    /// Producer uses the runtime; replay against fresh workbook + recompute
    /// yields the same observable state, including names + extra sheet.
    #[test]
    fn opl_2b_02_full_op_vocabulary_producer_replay_equivalence() {
        use ql_oplog::{replay_into, OpLog};
        use ql_storage::NamedTarget;
        let mut producer_wb = Workbook::new();
        producer_wb.add_sheet("S0");
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
            // SetName.
            rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
                .unwrap();
            // AddSheet.
            let sheet_id = rt.add_sheet("S1", 16_384).unwrap();
            // PutValue on sheet 0.
            rt.set_value(0, 0, 0, Value::Number(100.0)).unwrap();
            // PutFormula on sheet 0.
            rt.set_formula(0, 0, 1, "A1 * TaxRate").unwrap();
            // PutValue + ClearFormula (set_value over a formula cell).
            rt.set_formula(0, 0, 2, "A1 + 1").unwrap();
            rt.set_value(0, 0, 2, Value::Number(999.0)).unwrap();
            // Explicit ClearFormula on a fresh formula cell.
            rt.set_formula(0, 0, 3, "A1 - 1").unwrap();
            rt.clear_formula(0, 0, 3).unwrap();
            // Transaction → BatchCommit on sheet 1.
            {
                let mut tx = rt.transaction();
                tx.put_value(sheet_id, 0, 0, Value::Number(7.0)).unwrap();
                tx.put_formula(sheet_id, 0, 1, "A1 * 2").unwrap();
                tx.commit().unwrap();
            }
        }

        // Replay against a fresh workbook.
        let mut replay_wb = Workbook::new();
        replay_wb.add_sheet("S0");
        replay_into(&oplog, &mut replay_wb, &reg).unwrap();
        // Recompute_all to materialize formula values from replayed text.
        {
            let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
            assert!(rt.recompute_all().is_complete());
        }

        // Equivalence: sheet count, name table, every cell + formula text.
        assert_eq!(replay_wb.sheet_count(), producer_wb.sheet_count());
        assert_eq!(replay_wb.sheet_count(), 2);
        // Name persisted.
        assert!(matches!(
            replay_wb.names().lookup_ci("TaxRate"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        // Cell values match on sheet 0.
        for col in 0..4 {
            assert_eq!(
                replay_wb.read(ql_types::Address::new(0, 0, col)),
                producer_wb.read(ql_types::Address::new(0, 0, col)),
                "cell (0, 0, {col}) differs"
            );
        }
        // Cell values match on sheet 1.
        for col in 0..2 {
            assert_eq!(
                replay_wb.read(ql_types::Address::new(1, 0, col)),
                producer_wb.read(ql_types::Address::new(1, 0, col)),
                "cell (1, 0, {col}) differs"
            );
        }
        // Formula at (0, 0, 3) was cleared in both.
        assert!(replay_wb.formula_at(0, 0, 3).is_none());
        // Cell (0, 0, 2) was overwritten by set_value — formula text gone in both.
        assert!(replay_wb.formula_at(0, 0, 2).is_none());
        assert_eq!(
            replay_wb.read(ql_types::Address::new(0, 0, 2)),
            Value::Number(999.0)
        );
    }

    // ===== Phase 3.1 — calcgraph runtime integration =====

    /// G3-02 / hook-coverage test: each runtime mutation calls the
    /// corresponding calcgraph hook. Attach a `CalcgraphSession`, drive
    /// the runtime through all 5 mutation kinds, verify counters.
    #[test]
    fn runtime_mutations_fire_calcgraph_hooks() {
        use crate::CalcgraphSession;
        use ql_storage::NamedTarget;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            // set_value on a blank cell → on_set_value, NOT on_clear_formula
            rt.set_value(0, 0, 0, Value::Number(10.0)).unwrap();
            // set_formula → on_set_formula
            rt.set_formula(0, 1, 0, "A1 + 1").unwrap();
            // set_value over the formula → on_set_value + on_clear_formula
            rt.set_value(0, 1, 0, Value::Number(99.0)).unwrap();
            // clear_formula on a non-formula cell → on_clear_formula is
            // NOT called (no-op exit). Verified by counter staying flat.
            rt.clear_formula(0, 5, 5).unwrap();
            // set_formula + clear_formula → on_set_formula + on_clear_formula
            rt.set_formula(0, 2, 0, "A1 * 3").unwrap();
            rt.clear_formula(0, 2, 0).unwrap();
            // set_name → on_set_name
            rt.set_name("Rate", NamedTarget::Constant(Value::Number(0.5)))
                .unwrap();
            // add_sheet → on_add_sheet
            let _new_id = rt.add_sheet("S2", 16_384).unwrap();
        }
        let counts = graph.hook_counts();
        assert_eq!(counts.set_value, 2, "set_value fired twice");
        assert_eq!(counts.set_formula, 2, "set_formula fired twice");
        // clear_formula fires: once from set_value-over-formula, once
        // from explicit clear_formula on the formula at (2, 0). The
        // no-op clear at (5, 5) does NOT increment because
        // `clear_formula` short-circuits on `!had_formula` before
        // calling the hook.
        assert_eq!(counts.clear_formula, 2);
        assert_eq!(counts.set_name, 1);
        assert_eq!(counts.add_sheet, 1);
    }

    /// G3-01 + integration: rebuild a graph from an existing workbook,
    /// then continue editing through the runtime — new mutations
    /// register on the same graph, and the cell index reflects every
    /// formula cell.
    #[test]
    fn rebuild_then_edit_keeps_cell_index_in_sync() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Seed with two formulas BEFORE attaching the graph.
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_value(0, 0, 0, Value::Number(10.0)).unwrap();
            rt.set_formula(0, 1, 0, "A1 + 1").unwrap();
            rt.set_formula(0, 2, 0, "A1 * 2").unwrap();
        }

        // Now rebuild a session from the workbook. Phase 3.2 — rebuild
        // now returns `RebuildResult` with per-formula failure aggregation.
        let rebuild = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(rebuild.is_complete(), "no formula should fail to bind");
        assert_eq!(rebuild.attempted, 2);
        assert_eq!(rebuild.succeeded, 2);
        let mut graph = rebuild.session;
        assert_eq!(
            graph.graph().node_count(),
            2,
            "rebuild creates one node per existing formula"
        );
        assert!(graph.cell_node_for(0, 1, 0).is_some());
        assert!(graph.cell_node_for(0, 2, 0).is_some());

        // Attach to the runtime and add a third formula. The graph
        // sees the new node.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 3, 0, "A1 - 5").unwrap();
        }
        assert_eq!(graph.graph().node_count(), 3);
        assert!(graph.cell_node_for(0, 3, 0).is_some());
    }

    /// Without an attached graph, the runtime behaves identically to
    /// pre-3.1. Regression guard.
    #[test]
    fn runtime_without_graph_works_as_before() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 0, 0, Value::Number(7.0)).unwrap();
        let v = rt.set_formula(0, 1, 0, "A1 * 2").unwrap();
        assert_eq!(v, Value::Number(14.0));
        rt.clear_formula(0, 1, 0).unwrap();
    }

    /// Combined `with_oplog_and_graph` constructor: both op log AND
    /// graph receive their respective updates.
    #[test]
    fn runtime_with_oplog_and_graph_drives_both() {
        use crate::CalcgraphSession;
        use ql_oplog::{Op, OpLog};
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt =
                WorkbookRuntime::with_oplog_and_graph(&mut wb, &reg, &mut oplog, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
            rt.set_formula(0, 1, 0, "A1 + 1").unwrap();
        }
        // Op log captured both ops.
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 2);
        assert!(matches!(ops[0], Op::PutValue { .. }));
        assert!(matches!(ops[1], Op::PutFormula { .. }));
        // Graph saw both hooks.
        let counts = graph.hook_counts();
        assert_eq!(counts.set_value, 1);
        assert_eq!(counts.set_formula, 1);
    }

    // ----------------------------------------------------------------
    // Phase 3.4 integration: WorkbookRuntime::recompute_dirty drives
    // the calcgraph schedule + writes results to the workbook.
    // ----------------------------------------------------------------

    /// Phase 3.4: with no graph attached, `recompute_dirty` returns
    /// None — the dirty set lives on the session, so without one
    /// there's nothing to drive.
    #[test]
    fn recompute_dirty_returns_none_when_no_graph_attached() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        assert!(rt.recompute_dirty().is_none());
    }

    /// SCH-3-01 end-to-end: edit a chain head, recompute_dirty
    /// cascades through the chain. A1=1; B1=A1+1; C1=B1+1. After
    /// set_value(A1, 10), B1 and C1 should both update to 11 and 12.
    #[test]
    fn recompute_dirty_cascades_dependency_chain() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        // Seed via the runtime so the graph gets the hooks.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap();
            rt.set_formula(0, 0, 1, "A1 + 1").unwrap();
            rt.set_formula(0, 0, 2, "B1 + 1").unwrap();
        }
        // After the initial sets, B1 = 2, C1 = 3.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));

        // Edit A1 → 10 — the chain must propagate.
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(10.0)).unwrap();
        let result = rt.recompute_dirty().expect("graph attached");
        // Both B1 and C1 were dirty; both recomputed cleanly.
        assert_eq!(result.attempted, 2);
        assert_eq!(result.succeeded, 2);
        assert!(result.failures.is_empty());

        // Verify: B1 = 11, C1 = 12.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(11.0),
            "B1 = A1 + 1 = 11"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 2)),
            Value::Number(12.0),
            "C1 = B1 + 1 = 12"
        );
    }

    /// SCH-3-02 end-to-end: cycles get `#CIRC!`. Build A1 = B1 + 1
    /// and B1 = A1 + 1 (a 2-cycle), then trigger a recompute. Every
    /// cell in the SCC must be `Value::Error(ErrorValue::Circ)`.
    ///
    /// Note: we build the cycle directly via the workbook's low-level
    /// `put_formula` API and rebuild the session. Going through
    /// `WorkbookRuntime::set_formula` for the second cycle member
    /// would re-evaluate A1 mid-cycle and write a non-cycle value,
    /// which is fine — but it complicates the test setup. The
    /// rebuild path is the canonical "load existing workbook" entry
    /// the IDE uses and is the cleanest way to set up the test.
    #[test]
    fn recompute_dirty_writes_circ_error_for_cycle_members() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        wb.put_at(0, 0, 0, Value::Blank);
        wb.put_at(0, 0, 1, Value::Blank);
        wb.put_formula(0, 0, 0, "B1 + 1");
        wb.put_formula(0, 0, 1, "A1 + 1");
        let rebuild = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(rebuild.is_complete());
        let mut graph = rebuild.session;
        assert!(graph.dirty_formulas().is_empty(), "rebuild starts clean");

        // Mark the cycle dirty. on_set_value(A1) → cell_to_formulas[A1]
        // = {B1} → mark B1 dirty. BFS from B1 → cell_to_formulas[B1]
        // = {A1} → mark A1 dirty. The Tarjan SCC scheduler discovers
        // the cycle.
        graph.on_set_value(0, 0, 0);
        assert_eq!(graph.dirty_formulas().len(), 2);

        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        let result = rt.recompute_dirty().expect("graph attached");
        // Both members are in cycled (not sorted); attempted == 2.
        assert_eq!(result.attempted, 2);
        // `succeeded` counts only sorted-path evaluations.
        assert_eq!(result.succeeded, 0);
        assert!(result.failures.is_empty());

        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Error(ErrorValue::Circ),
            "A1 in cycle → #CIRC!"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::Circ),
            "B1 in cycle → #CIRC!"
        );
    }

    /// SCH-3-04 end-to-end: an edit to A1 cascades through its
    /// chain, but an UNRELATED formula `=Z1+1` at E1 stays untouched.
    #[test]
    fn recompute_dirty_skips_unrelated_formulas() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap(); // A1
            rt.set_value(0, 0, 25, Value::Number(100.0)).unwrap(); // Z1
            rt.set_formula(0, 0, 1, "A1 + 1").unwrap(); // B1
            rt.set_formula(0, 0, 4, "Z1 + 1").unwrap(); // E1
        }
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 4)),
            Value::Number(101.0)
        );

        // Edit A1; E1 should NOT recompute.
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(50.0)).unwrap();
        let result = rt.recompute_dirty().expect("graph attached");
        // Only B1 was dirty.
        assert_eq!(result.attempted, 1);
        assert_eq!(result.succeeded, 1);

        // B1 updated to 51.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(51.0)
        );
        // E1 untouched (its value would still be the prior 101).
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 4)),
            Value::Number(101.0),
            "E1 must not have been recomputed"
        );
    }

    // ----------------------------------------------------------------
    // Phase 3.5 (W5-38) — OVR-3-01..04 computed-overlay separation
    // acceptance tests. CORR-25.
    // ----------------------------------------------------------------

    /// OVR-3-01: `set_formula` writes the evaluated value to the COMPUTED
    /// overlay, not the user lane. Inspect each overlay directly via the
    /// column store to verify lane-routing.
    #[test]
    fn ovr_3_01_set_formula_writes_to_computed_overlay_not_user() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap(); // A1 user-value
            rt.set_formula(0, 0, 1, "A1 * 2").unwrap(); // B1 = formula
        }
        // A1: user lane has the value; computed lane is empty.
        let col_a = wb.sheet(0).unwrap().column(0).unwrap();
        assert_eq!(
            col_a.user_overlay(0).unwrap().get(0),
            Some(&Value::Number(5.0))
        );
        assert_eq!(col_a.computed_overlay(0).unwrap().get(0), None);
        // B1: computed has the formula's evaluated value (10.0); user is empty.
        let col_b = wb.sheet(0).unwrap().column(1).unwrap();
        assert_eq!(
            col_b.computed_overlay(0).unwrap().get(0),
            Some(&Value::Number(10.0))
        );
        assert_eq!(
            col_b.user_overlay(0).unwrap().get(0),
            None,
            "OVR-3-01: formula must NOT mutate user overlay"
        );
    }

    /// OVR-3-02: typing a literal value over a formula cell clears both
    /// the formula text AND the computed-overlay entry. Excel canon:
    /// "user types over a formula → formula gone, cell becomes literal."
    #[test]
    fn ovr_3_02_typing_over_formula_clears_formula_and_computed() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
            rt.set_formula(0, 0, 1, "A1 * 2").unwrap();
            // Now type a literal over B1.
            rt.set_value(0, 0, 1, Value::Number(99.0)).unwrap();
        }
        // Formula text is gone.
        assert!(wb.formula_at(0, 0, 1).is_none());
        // Computed overlay at B1 is gone.
        let col_b = wb.sheet(0).unwrap().column(1).unwrap();
        assert_eq!(col_b.computed_overlay(0).unwrap().get(0), None);
        // User overlay has the new literal.
        assert_eq!(
            col_b.user_overlay(0).unwrap().get(0),
            Some(&Value::Number(99.0))
        );
        // Public read returns the user value.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(99.0)
        );
    }

    /// OVR-3-02 sister: explicit `clear_formula` (Excel "strip formula,
    /// keep value") MOVES the formula's last evaluated value into the
    /// user lane so the visible value persists. The op log records the
    /// PutValue + ClearFormula pair so replay produces the same state.
    #[test]
    fn ovr_3_02b_clear_formula_promotes_value_to_user_lane() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(0, 0, 0, "3 + 4").unwrap(); // A1 = formula, value 7
            rt.clear_formula(0, 0, 0).unwrap();
        }
        assert!(wb.formula_at(0, 0, 0).is_none());
        let col = wb.sheet(0).unwrap().column(0).unwrap();
        // Value moved to user lane.
        assert_eq!(
            col.user_overlay(0).unwrap().get(0),
            Some(&Value::Number(7.0))
        );
        // Computed lane empty.
        assert_eq!(col.computed_overlay(0).unwrap().get(0), None);
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(7.0));
    }

    /// OVR-3-03: save+load round-trip preserves lane assignment. A
    /// workbook with a user-typed cell + a formula cell with computed
    /// output, after `save_workbook` + `load_workbook`, has the same
    /// lane layout (verified by inspecting overlays after load).
    #[test]
    fn ovr_3_03_save_load_preserves_layer() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ovr_3_03.qbook");
        // Build a workbook through the runtime so layers are correct.
        {
            let mut wb = make_runtime_workbook();
            let reg = default_registry();
            {
                let mut rt = WorkbookRuntime::new(&mut wb, &reg);
                rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
                rt.set_formula(0, 0, 1, "A1 * 2").unwrap();
            }
            ql_io::save_workbook(&wb, "OVR-3-03", &path).unwrap();
        }
        // Load and inspect.
        let wb_loaded = ql_io::load_workbook(&path).unwrap();
        // A1: user lane.
        let col_a = wb_loaded.sheet(0).unwrap().column(0).unwrap();
        assert_eq!(
            col_a.user_overlay(0).unwrap().get(0),
            Some(&Value::Number(5.0))
        );
        assert_eq!(col_a.computed_overlay(0).unwrap().get(0), None);
        // B1: computed lane with the saved formula output. Formula text preserved.
        assert_eq!(
            wb_loaded.formula_at(0, 0, 1).map(|s| s.as_ref()),
            Some("A1 * 2")
        );
        let col_b = wb_loaded.sheet(0).unwrap().column(1).unwrap();
        assert_eq!(
            col_b.computed_overlay(0).unwrap().get(0),
            Some(&Value::Number(10.0)),
            "OVR-3-03: formula output must land in computed on load"
        );
        assert_eq!(
            col_b.user_overlay(0).unwrap().get(0),
            None,
            "OVR-3-03: load must NOT route formula values to user overlay"
        );
    }

    /// OVR-3-04: reads through the cascade see the right value in every
    /// scenario — user-only cell, formula-only cell, base-only cell.
    /// The runtime's public `Workbook::read` is the cascade entry point.
    #[test]
    fn ovr_3_04_read_cascade_consistent_across_lane_types() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // A1: pure user value.
            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap();
            // B1: formula → computed lane.
            rt.set_formula(0, 0, 1, "A1 * 10").unwrap();
            // C1: user, then formula on top (formula must shadow user).
            rt.set_value(0, 0, 2, Value::Number(999.0)).unwrap();
            rt.set_formula(0, 0, 2, "A1 + 100").unwrap();
            // D1: formula, then literal on top (literal must shadow formula's computed).
            rt.set_formula(0, 0, 3, "A1 * 5").unwrap();
            rt.set_value(0, 0, 3, Value::Number(7777.0)).unwrap();
        }
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(10.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 2)),
            Value::Number(101.0),
            "C1: formula replaced user; read sees computed 101"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Number(7777.0),
            "D1: literal replaced formula; read sees user 7777"
        );
    }

    // ----------------------------------------------------------------
    // Phase 3.6 (W5-39) — AGG-3-01..04 acceptance tests (CORR-25 follow-up).
    // ----------------------------------------------------------------

    /// Helper: build a workbook with a named range `BigRange` over A1:A`size`
    /// pre-populated with values 1..=size, and a SUM(BigRange) formula at B1.
    /// Returns (wb, session) after rebuild — session has 0 cached aggregates.
    fn build_aggregate_workbook(size: u32) -> (Workbook, crate::CalcgraphSession) {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        for r in 0..size {
            wb.put_at(0, r, 0, Value::Number((r + 1) as f64));
        }
        wb.set_name(
            "BigRange",
            NamedTarget::Range(Range::new(0, 0, 0, size - 1, 0)),
        )
        .unwrap();
        wb.put_at(0, 0, 1, Value::Blank);
        wb.put_formula(0, 0, 1, "SUM(BigRange)");
        let rebuild = crate::CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(rebuild.is_complete());
        (wb, rebuild.session)
    }

    /// AGG-3-04 (correctness baseline): SUM/AVERAGE/MIN/MAX/COUNT/PRODUCT
    /// over a named range produce the same result as the scalar baseline.
    /// Sales = A1:A5 = [1, 2, 3, 4, 5]: SUM = 15, AVERAGE = 3, MIN = 1,
    /// MAX = 5, COUNT = 5, PRODUCT = 120.
    #[test]
    fn agg_3_04_results_match_scalar_baseline() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        for r in 0..5 {
            wb.put_at(0, r, 0, Value::Number((r + 1) as f64));
        }
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        assert_eq!(
            rt.set_formula(0, 0, 1, "SUM(Sales)").unwrap(),
            Value::Number(15.0)
        );
        assert_eq!(
            rt.set_formula(0, 1, 1, "AVERAGE(Sales)").unwrap(),
            Value::Number(3.0)
        );
        assert_eq!(
            rt.set_formula(0, 2, 1, "MIN(Sales)").unwrap(),
            Value::Number(1.0)
        );
        assert_eq!(
            rt.set_formula(0, 3, 1, "MAX(Sales)").unwrap(),
            Value::Number(5.0)
        );
        assert_eq!(
            rt.set_formula(0, 4, 1, "COUNT(Sales)").unwrap(),
            Value::Number(5.0)
        );
        assert_eq!(
            rt.set_formula(0, 5, 1, "PRODUCT(Sales)").unwrap(),
            Value::Number(120.0)
        );
    }

    /// AGG-3-01: `SUM(BigRange)` does NOT rescan the range on an unrelated
    /// write. We use a 1000-row range to make the cost asymmetric; a write
    /// to a cell OUTSIDE the range, followed by `recompute_dirty`, should
    /// produce a cache HIT (the SUM result is reused).
    #[test]
    fn agg_3_01_no_rescan_on_unrelated_writes() {
        let (mut wb, mut graph) = build_aggregate_workbook(1000);
        let reg = default_registry();
        // First eval: populates the cache.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            // Re-set the formula via the runtime so the eval path uses the
            // session cache. `build_aggregate_workbook` used the low-level
            // workbook API which doesn't populate the session cache.
            rt.set_formula(0, 0, 1, "SUM(BigRange)").unwrap();
        }
        let s_after_first = graph.aggregate_cache_stats();
        assert_eq!(s_after_first.misses, 1, "first eval is a cold miss");
        assert_eq!(s_after_first.hits, 0);

        // Unrelated write at column Z (col 25) — outside BigRange (col 0).
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 25, Value::Number(999.0)).unwrap();
            // No formula at Z1; recompute_dirty has nothing to do for
            // the chain. The cache should NOT have been invalidated.
            rt.recompute_dirty().unwrap();
        }
        let s_after_unrelated = graph.aggregate_cache_stats();
        assert_eq!(
            s_after_unrelated.invalidations, 0,
            "unrelated write outside BigRange must not invalidate cache"
        );

        // Re-evaluate the SUM formula to trigger a lookup → hit.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 1, "SUM(BigRange)").unwrap();
        }
        let s_after_second = graph.aggregate_cache_stats();
        assert!(
            s_after_second.hits > s_after_first.hits,
            "AGG-3-01: second eval must hit the cache (hits before={}, after={})",
            s_after_first.hits,
            s_after_second.hits
        );
    }

    /// AGG-3-02: a write INSIDE BigRange invalidates the cache. After the
    /// invalidation, the next eval is a miss + fresh computation.
    #[test]
    fn agg_3_02_intersecting_write_invalidates_cache() {
        let (mut wb, mut graph) = build_aggregate_workbook(10);
        let reg = default_registry();
        // First eval populates cache.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let v = rt.set_formula(0, 0, 1, "SUM(BigRange)").unwrap();
            assert_eq!(v, Value::Number(55.0)); // 1+2+...+10 = 55
        }
        assert_eq!(graph.aggregate_cache_stats().invalidations, 0);

        // Write to A5 (inside BigRange) — must invalidate.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 4, 0, Value::Number(100.0)).unwrap();
        }
        assert!(
            graph.aggregate_cache_stats().invalidations >= 1,
            "AGG-3-02: write inside range must invalidate"
        );

        // Re-evaluate; the new value (5 → 100) shifts the sum from 55 to 150.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let v = rt.set_formula(0, 0, 1, "SUM(BigRange)").unwrap();
            assert_eq!(v, Value::Number(150.0));
        }
    }

    /// AGG-3-03: full-column aggregate remains compressed. We register a
    /// `SUM(WholeCol)` where WholeCol is start_row=0, end_row=RowId::MAX
    /// — the stripe should still be ONE entry (per DIR-3-04). Phase 3.6
    /// re-verifies in the aggregate-eval context: the eval doesn't blow
    /// up trying to iterate 4 billion rows; it clamps via Sheet::bounds.
    #[test]
    fn agg_3_03_full_column_aggregate_remains_compressed() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        // Populate a few cells; bounds determines the clamp.
        for r in 0..50 {
            wb.put_at(0, r, 0, Value::Number(1.0));
        }
        wb.set_name(
            "WholeCol",
            NamedTarget::Range(Range {
                sheet: 0,
                start_row: 0,
                start_col: 0,
                end_row: ql_types::RowId::MAX, // whole column
                end_col: 0,
            }),
        )
        .unwrap();
        let reg = default_registry();
        let mut graph = crate::CalcgraphSession::new();
        let v = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 1, "SUM(WholeCol)").unwrap()
        };
        // 50 ones = 50. The clamp via Sheet::bounds prevents iterating
        // RowId::MAX cells.
        assert_eq!(v, Value::Number(50.0));
        // Stripe still compressed: ONE Column-0 entry (verified at DIR-
        // 3-04; reaffirm here in the aggregate path).
        assert_eq!(
            graph.graph().stripe_index().stripe_count(),
            1,
            "AGG-3-03: full-column dep registers a single stripe"
        );
    }

    // ----------------------------------------------------------------
    // Phase 3.7 (W5-40) — VOL-3-01..03 acceptance tests.
    // ----------------------------------------------------------------

    /// VOL-3-03: deterministic RNG test fixture exists. The
    /// `ql_functions::set_test_rng_seed` helper produces a fixed RAND()
    /// sequence; re-seeding reproduces the same first value.
    #[test]
    fn vol_3_03_seeded_rng_produces_deterministic_rand_sequence() {
        ql_functions::set_test_rng_seed(0xCAFE_F00D_DEAD_BEEF);
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v1 = rt.set_formula(0, 0, 0, "RAND()").unwrap();

        // Re-seed and run again; same first value.
        ql_functions::set_test_rng_seed(0xCAFE_F00D_DEAD_BEEF);
        let mut wb2 = make_runtime_workbook();
        let mut rt2 = WorkbookRuntime::new(&mut wb2, &reg);
        let v2 = rt2.set_formula(0, 0, 0, "RAND()").unwrap();

        assert_eq!(v1, v2, "VOL-3-03: same seed → same RAND() value");
        match v1 {
            Value::Number(n) => assert!((0.0..1.0).contains(&n)),
            _ => panic!("RAND should return a Number"),
        }
        ql_functions::clear_test_overrides();
    }

    /// VOL-3-01: marking volatile dirty + recompute_dirty re-evaluates
    /// the volatile formula. With the seeded RNG, the value advances
    /// to the next position in the deterministic sequence.
    #[test]
    fn vol_3_01_volatile_formulas_recompute_when_requested() {
        ql_functions::set_test_rng_seed(0x1234_5678_9ABC_DEF0);
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = crate::CalcgraphSession::new();
        let initial = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "RAND()").unwrap()
        };
        assert_eq!(graph.volatile_count(), 1, "RAND() is volatile");

        let marked = graph.mark_volatile_dirty();
        assert_eq!(marked, 1);
        let updated = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let _ = rt.recompute_dirty().expect("graph attached");
            wb.read(ql_types::Address::new(0, 0, 0))
        };
        assert_ne!(
            initial, updated,
            "VOL-3-01: volatile formula must produce a new value after the tick"
        );
        ql_functions::clear_test_overrides();
    }

    /// VOL-3-02: a non-volatile formula `=A1 + 1` (where A1 = RAND())
    /// recomputes when A1's volatile tick fires.
    #[test]
    fn vol_3_02_nonvolatile_dependents_update_when_volatile_changes() {
        ql_functions::set_test_rng_seed(0xAAAA_BBBB_CCCC_DDDD);
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = crate::CalcgraphSession::new();
        let (initial_a1, initial_b1) = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let a1 = rt.set_formula(0, 0, 0, "RAND()").unwrap();
            let b1 = rt.set_formula(0, 0, 1, "A1 + 1").unwrap();
            (a1, b1)
        };
        match (initial_a1.clone(), initial_b1.clone()) {
            (Value::Number(a), Value::Number(b)) => {
                assert!((a + 1.0 - b).abs() < 1e-12);
            }
            _ => panic!("expected Number values"),
        }

        graph.mark_volatile_dirty();
        let (new_a1, new_b1) = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let _ = rt.recompute_dirty().expect("graph attached");
            (
                wb.read(ql_types::Address::new(0, 0, 0)),
                wb.read(ql_types::Address::new(0, 0, 1)),
            )
        };
        assert_ne!(initial_a1, new_a1, "RAND() advanced");
        assert_ne!(initial_b1, new_b1, "B1 = A1 + 1 reflects new A1");
        match (new_a1, new_b1) {
            (Value::Number(a), Value::Number(b)) => assert!(
                (a + 1.0 - b).abs() < 1e-12,
                "VOL-3-02: B1 must still equal A1 + 1 after recompute"
            ),
            _ => panic!("expected Number values"),
        }
        ql_functions::clear_test_overrides();
    }

    // ----------------------------------------------------------------
    // Phase 3.8 (W5-41) — VEQ-3-01..03 acceptance tests.
    // ----------------------------------------------------------------

    /// VEQ-3-01: when an upstream's recomputed value equals its prior
    /// value, downstream formulas that depend only on it are SKIPPED.
    /// Setup: A1 = 1 literal; B1 = A1 + 1 (= 2); C1 = B1 + 1 (= 3).
    /// Trigger: edit A1 to 1 (same value). Both B1 and C1 are marked
    /// dirty via the Phase 3.3 BFS. After recompute_dirty:
    ///
    /// - B1 re-evaluates (top-level dirty); value unchanged → suppress.
    /// - C1 skipped entirely (its only changed-upstream candidate, B1,
    ///   stayed unchanged).
    ///
    /// Observable: `skipped_value_equality` ≥ 1, and no extra writes
    /// to B1/C1.
    #[test]
    fn veq_3_01_unchanged_upstream_suppresses_downstream_recompute() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = crate::CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap();
            rt.set_formula(0, 0, 1, "A1 + 1").unwrap();
            rt.set_formula(0, 0, 2, "B1 + 1").unwrap();
        }
        // Sanity baseline.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));

        // Edit A1 to the SAME value — triggers dirty propagation but
        // no actual change.
        let result = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap();
            rt.recompute_dirty().expect("graph attached")
        };
        // VEQ-3-03: profile records skipped vertices.
        assert!(
            result.skipped_value_equality >= 1,
            "VEQ-3-01: at least one of B1/C1 must be skipped (skipped={})",
            result.skipped_value_equality
        );
        // C1 specifically is the downstream-of-downstream — it should
        // be skipped because B1's value didn't change.
        assert_eq!(
            result.skipped_value_equality, 2,
            "Both B1 (value-equality on output) and C1 (skip because B1 unchanged) should be skipped"
        );
        // Values still correct.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
    }

    /// VEQ-3-02: error equality is correct. A formula that re-evaluates
    /// to the same `#DIV/0!` error should be treated as equal — no
    /// write, downstream skipped. Setup: A1 = 10 / 0 (→ #DIV/0!);
    /// B1 = A1 + 1 (→ #DIV/0!, error propagation).
    /// Edit A1's formula to the same text → still #DIV/0!. B1 skipped.
    #[test]
    fn veq_3_02_error_equality_suppresses_downstream() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = crate::CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 5, Value::Number(0.0)).unwrap(); // F1 = 0
            rt.set_formula(0, 0, 0, "10 / F1").unwrap(); // A1 = #DIV/0!
            rt.set_formula(0, 0, 1, "A1 + 1").unwrap(); // B1 = #DIV/0!
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Error(ErrorValue::DivZero)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::DivZero)
        );

        // Edit F1 to 0 (same value) — triggers dirty cascade.
        let result = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 5, Value::Number(0.0)).unwrap();
            rt.recompute_dirty().expect("graph attached")
        };
        // Both A1 and B1 stayed at #DIV/0!. Skip count covers both.
        assert!(
            result.skipped_value_equality >= 1,
            "VEQ-3-02: error-valued cells with unchanged errors must skip"
        );
        // Re-confirm values.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Error(ErrorValue::DivZero)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::DivZero)
        );
    }

    /// VEQ-3-03: the `skipped_value_equality` counter on
    /// `RecomputeResult` is the public profile surface for value-
    /// equality short-circuit. This test asserts the field exists,
    /// is non-zero when skips occur, and stays 0 when every dirty
    /// formula actually changed.
    #[test]
    fn veq_3_03_profile_records_skipped_vertices() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = crate::CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap();
            rt.set_formula(0, 0, 1, "A1 + 1").unwrap();
        }

        // Case 1: no-change edit → skip > 0.
        let r1 = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap();
            rt.recompute_dirty().expect("graph attached")
        };
        assert!(r1.skipped_value_equality > 0);

        // Case 2: real change → skip = 0.
        let r2 = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(100.0)).unwrap();
            rt.recompute_dirty().expect("graph attached")
        };
        assert_eq!(
            r2.skipped_value_equality, 0,
            "VEQ-3-03: value DID change; no skips expected"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(101.0)
        );

        // Case 3: `recompute_all` legacy path — skipped is always 0.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let r3 = rt.recompute_all();
        assert_eq!(
            r3.skipped_value_equality, 0,
            "recompute_all doesn't run VEQ — field is always 0"
        );
    }

    /// VEQ regression: a volatile formula (RAND) is NEVER skipped on
    /// value-equality — its value can change between calls without
    /// any cell edit. The Phase 3.7 mark_volatile_dirty path triggers
    /// the recompute; even if the seeded RAND happened to produce the
    /// same value twice in a row, the formula must still re-evaluate.
    #[test]
    fn veq_does_not_skip_volatile_formulas() {
        ql_functions::set_test_rng_seed(0x4242_4242_4242_4242);
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = crate::CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "RAND()").unwrap();
        }
        graph.mark_volatile_dirty();
        let result = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.recompute_dirty().expect("graph attached")
        };
        // Volatile formulas always re-evaluate; never counted as
        // value-equality skips.
        assert_eq!(result.skipped_value_equality, 0);
        ql_functions::clear_test_overrides();
    }

    // ----------------------------------------------------------------
    // Phase 3.9 (W5-42) — SIMD-3-01..03 acceptance tests.
    // ----------------------------------------------------------------

    /// SIMD-3-01: the bench-side multiversion-clone path (the OG-02
    /// `=A*2` 25M-cell kernel) still binds to a recognized
    /// `SimdShape::MulScalar`. The `bash scripts/check-multiversion-
    /// clones.sh` gate verifies the binary disassembly; this unit
    /// test verifies the upstream `lower::classify` still produces
    /// the expected shape, so the graph scheduler and the bench
    /// agree on which plans are SIMD-eligible.
    #[test]
    fn simd_3_01_og02_pattern_classifies_to_mul_scalar() {
        use crate::plan::{bind, ExprPlan};
        use ql_formula_syntax::{lex, parse};
        // Parse `=A1 * 2` (Excel canon: 1-based row in source).
        let tokens = lex("A1 * 2").unwrap();
        let expr = parse(tokens).unwrap();
        let plan = bind(&expr, 0).unwrap();
        let shape = crate::lower::classify(&plan);
        assert!(matches!(shape, crate::SimdShape::MulScalar { .. }));
        // And the converse: a non-arithmetic expression doesn't
        // accidentally claim eligibility.
        assert!(matches!(plan, ExprPlan::Binary { .. }));
        let str_plan = ExprPlan::String("hello".into());
        assert!(matches!(
            crate::lower::classify(&str_plan),
            crate::SimdShape::NotApplicable
        ));
    }

    /// SIMD-3-02: scalar fallback for division. `lower::classify`
    /// MUST return `NotApplicable` for `=A1 / 2` so the Excel-canon
    /// `#DIV/0!` error class is preserved (a SIMD reciprocal-mul
    /// path would produce `+Inf` and surface as `#NUM!` — wrong).
    /// This is the Phase 2A.9 H5 fix; Phase 3.9 re-affirms.
    #[test]
    fn simd_3_02_division_falls_back_to_scalar() {
        use crate::plan::bind;
        use ql_formula_syntax::{lex, parse};
        // A1 / 2 — SIMD-recognized op shape but div semantics
        // force scalar fallback.
        let tokens = lex("A1 / 2").unwrap();
        let expr = parse(tokens).unwrap();
        let plan = bind(&expr, 0).unwrap();
        assert_eq!(
            crate::lower::classify(&plan),
            crate::SimdShape::NotApplicable,
            "Operator::Div MUST NOT be SIMD-lowered (Phase 2A.9 H5)"
        );

        // End-to-end: `=10/0` produces `#DIV/0!` through the runtime,
        // not `#NUM!` (which would happen if reciprocal-mul SIMD
        // were used).
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 0, "10 / 0").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::DivZero));
    }

    /// SIMD-3-03: graph profile shows region execution.
    /// `RecomputeResult.simd_classified` counts how many dirty
    /// formulas had plans that `classify()` recognized as SIMD-
    /// eligible. A workbook with a mix of `=A*2` (SIMD-eligible)
    /// and `=SUM(Sales)` (not SIMD-eligible aggregate) edits then
    /// recomputes; the counter reflects the eligibility split.
    #[test]
    fn simd_3_03_profile_records_simd_eligible_formulas() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        for r in 0..5 {
            wb.put_at(0, r, 0, Value::Number(r as f64 + 1.0));
        }
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
            .unwrap();
        let reg = default_registry();
        let mut graph = crate::CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 1, "A1 * 2").unwrap(); // SIMD-eligible
            rt.set_formula(0, 1, 1, "A2 + 5").unwrap(); // SIMD-eligible
            rt.set_formula(0, 2, 1, "SUM(Sales)").unwrap(); // NotApplicable
            rt.set_formula(0, 3, 1, "A1 / 2").unwrap(); // NotApplicable (div)
        }

        // Trigger recompute by editing a cell inside Sales — that
        // dirties at least the SUM formula and any direct-cell-dep
        // formulas via the BFS.
        let result = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(100.0)).unwrap();
            rt.recompute_dirty().expect("graph attached")
        };
        // We don't pin the exact count because it depends on which
        // formulas the BFS reaches; we DO pin that the field is
        // exposed and non-zero (at least `A1 * 2` reaches recompute
        // since A1 is its direct cell dep).
        assert!(
            result.simd_classified >= 1,
            "SIMD-3-03: at least one SIMD-eligible formula reaches recompute_dirty (count={})",
            result.simd_classified
        );
        // Sanity: the legacy `recompute_all` path is always 0.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let r_all = rt.recompute_all();
        assert_eq!(
            r_all.simd_classified, 0,
            "recompute_all is the legacy path; simd_classified is always 0"
        );
    }

    // ----------------------------------------------------------------
    // W5-53 — Phase 4.3 V2 range-aware dispatch (GAP-F-05 closure).
    //
    // End-to-end tests that exercise SUMIF + COUNTIF through the full
    // parse → bind → eval pipeline. The eval-side dispatch at
    // `scalar.rs::eval_scalar_with_cache` now checks
    // `registry.lookup_range_aware` first and constructs `Vec<FnArg>`
    // with per-arg range/scalar variants. These tests verify the
    // wiring is correct end-to-end (not just via the unit tests in
    // `range_fns`).
    // ----------------------------------------------------------------

    /// SUMIF over a named range with numeric criteria.
    /// `Sales = A1:A5 = [1, 5, 5, 10, 5]`. `=SUMIF(Sales, 5)` should
    /// match the three 5's → 15.
    #[test]
    fn w5_53_sumif_named_range_numeric_criteria() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_at(0, 1, 0, Value::Number(5.0));
        wb.put_at(0, 2, 0, Value::Number(5.0));
        wb.put_at(0, 3, 0, Value::Number(10.0));
        wb.put_at(0, 4, 0, Value::Number(5.0));
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 1, "SUMIF(Sales, 5)").unwrap();
        assert_eq!(v, Value::Number(15.0));
    }

    /// SUMIF with a comparator criteria string.
    /// `=SUMIF(Sales, ">5")` → sum of cells > 5 → 10.
    #[test]
    fn w5_53_sumif_comparator_criteria() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_at(0, 1, 0, Value::Number(5.0));
        wb.put_at(0, 2, 0, Value::Number(10.0));
        wb.put_at(0, 3, 0, Value::Number(100.0));
        wb.set_name("Vals", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 1, "SUMIF(Vals, \">5\")").unwrap();
        assert_eq!(v, Value::Number(110.0));
    }

    /// COUNTIF over a named range. `=COUNTIF(Sales, ">=5")` → 4 cells.
    #[test]
    fn w5_53_countif_named_range() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_at(0, 1, 0, Value::Number(5.0));
        wb.put_at(0, 2, 0, Value::Number(10.0));
        wb.put_at(0, 3, 0, Value::Number(100.0));
        wb.put_at(0, 4, 0, Value::Number(5.0));
        wb.set_name("Vals", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 1, "COUNTIF(Vals, \">=5\")").unwrap();
        assert_eq!(v, Value::Number(4.0));
    }

    /// SUMIF with a 3-arg call: separate `sum_range`. Criteria range
    /// holds labels; sum range holds the values. Demonstrates the
    /// per-arg range distinction the W5-53 infra was built for.
    #[test]
    fn w5_53_sumif_with_separate_sum_range() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        use std::sync::Arc;
        let mut wb = make_runtime_workbook();
        // Labels column A: [apple, banana, apple, cherry, apple]
        wb.put_at(0, 0, 0, Value::Text(Arc::from("apple")));
        wb.put_at(0, 1, 0, Value::Text(Arc::from("banana")));
        wb.put_at(0, 2, 0, Value::Text(Arc::from("apple")));
        wb.put_at(0, 3, 0, Value::Text(Arc::from("cherry")));
        wb.put_at(0, 4, 0, Value::Text(Arc::from("apple")));
        // Values column B: [1, 2, 3, 4, 5]
        wb.put_at(0, 0, 1, Value::Number(1.0));
        wb.put_at(0, 1, 1, Value::Number(2.0));
        wb.put_at(0, 2, 1, Value::Number(3.0));
        wb.put_at(0, 3, 1, Value::Number(4.0));
        wb.put_at(0, 4, 1, Value::Number(5.0));
        wb.set_name("Labels", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
            .unwrap();
        wb.set_name("Vals", NamedTarget::Range(Range::new(0, 0, 1, 4, 1)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Sum the apple-labeled values: positions 0, 2, 4 → 1+3+5 = 9.
        let v = rt
            .set_formula(0, 0, 2, "SUMIF(Labels, \"apple\", Vals)")
            .unwrap();
        assert_eq!(v, Value::Number(9.0));
    }

    /// SUMIF interacts correctly with the recompute path (Phase 3.6
    /// aggregate cache is BYPASSED for range-aware functions — they
    /// are NOT in `is_aggregate_function`'s set, so they recompute
    /// on every edit). When a cell in the criteria range changes,
    /// the SUMIF formula must re-evaluate.
    #[test]
    fn w5_53_sumif_recomputes_on_range_cell_change() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        for r in 0..5 {
            wb.put_at(0, r, 0, Value::Number(r as f64 + 1.0));
        }
        wb.set_name("Vals", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
            .unwrap();
        let reg = default_registry();
        let mut graph = crate::CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let v = rt.set_formula(0, 0, 1, "SUMIF(Vals, \">2\")").unwrap();
            assert_eq!(v, Value::Number(3.0 + 4.0 + 5.0));
        }
        // Edit a cell in Vals — bumps A1 from 1.0 to 100.0.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(100.0)).unwrap();
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        // SUMIF formula at B1 should now include 100 → 100+3+4+5 = 112.
        let result = wb.read(ql_types::Address::new(0, 0, 1));
        assert_eq!(result, Value::Number(112.0));
    }

    // ----------------------------------------------------------------
    // W5-54 — Phase 4.3 V2 lookup family (VLOOKUP / HLOOKUP / MATCH /
    // INDEX / CHOOSE). End-to-end via the full parse → bind → eval
    // pipeline. The 2D shape from `read_range_with_shape` flows
    // through `FnArg::Range { values, rows, cols }`.
    // ----------------------------------------------------------------

    /// VLOOKUP with exact match against a 2-column table.
    #[test]
    fn w5_54_vlookup_exact_match_e2e() {
        use ql_storage::NamedTarget;
        use std::sync::Arc;
        let mut wb = make_runtime_workbook();
        // Table at A1:B3:
        //   apple   1
        //   banana  2
        //   cherry  3
        wb.put_at(0, 0, 0, Value::Text(Arc::from("apple")));
        wb.put_at(0, 0, 1, Value::Number(1.0));
        wb.put_at(0, 1, 0, Value::Text(Arc::from("banana")));
        wb.put_at(0, 1, 1, Value::Number(2.0));
        wb.put_at(0, 2, 0, Value::Text(Arc::from("cherry")));
        wb.put_at(0, 2, 1, Value::Number(3.0));
        wb.set_name(
            "Table",
            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 2, 1)),
        )
        .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt
            .set_formula(0, 0, 3, "VLOOKUP(\"banana\", Table, 2, FALSE)")
            .unwrap();
        assert_eq!(v, Value::Number(2.0));
    }

    /// VLOOKUP with approximate match (default range_lookup=TRUE) on
    /// an ascending-sorted first column.
    #[test]
    fn w5_54_vlookup_approximate_match_e2e() {
        use ql_storage::NamedTarget;
        use std::sync::Arc;
        let mut wb = make_runtime_workbook();
        // Grading table: score thresholds → grade letter.
        let rows = [
            (0.0, "F"),
            (60.0, "D"),
            (70.0, "C"),
            (80.0, "B"),
            (90.0, "A"),
        ];
        for (i, (threshold, grade)) in rows.iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Number(*threshold));
            wb.put_at(0, i as u32, 1, Value::Text(Arc::from(*grade)));
        }
        wb.set_name(
            "Grades",
            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 4, 1)),
        )
        .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Score 75 → largest ≤ 75 is 70 → grade "C".
        let v = rt.set_formula(0, 0, 3, "VLOOKUP(75, Grades, 2)").unwrap();
        assert_eq!(v, Value::Text(Arc::from("C")));
    }

    /// HLOOKUP with exact match on a 2-row × 3-col table.
    #[test]
    fn w5_54_hlookup_exact_match_e2e() {
        use ql_storage::NamedTarget;
        use std::sync::Arc;
        let mut wb = make_runtime_workbook();
        // Row 0: headers; Row 1: values.
        for (i, h) in ["a", "b", "c"].iter().enumerate() {
            wb.put_at(0, 0, i as u32, Value::Text(Arc::from(*h)));
        }
        for (i, v) in [10.0, 20.0, 30.0].iter().enumerate() {
            wb.put_at(0, 1, i as u32, Value::Number(*v));
        }
        wb.set_name(
            "HTable",
            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 1, 2)),
        )
        .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt
            .set_formula(0, 3, 0, "HLOOKUP(\"b\", HTable, 2, FALSE)")
            .unwrap();
        assert_eq!(v, Value::Number(20.0));
    }

    /// MATCH exact + INDEX combination — the canonical replacement
    /// for VLOOKUP. Demonstrates both functions plus the
    /// scalar-argument result feeding into another formula.
    #[test]
    fn w5_54_index_match_pattern_e2e() {
        use ql_storage::NamedTarget;
        use std::sync::Arc;
        let mut wb = make_runtime_workbook();
        // Lookup keys in column A, values in column B.
        for (i, key) in ["alpha", "beta", "gamma", "delta"].iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Text(Arc::from(*key)));
            wb.put_at(0, i as u32, 1, Value::Number(((i + 1) * 10) as f64));
        }
        wb.set_name(
            "Keys",
            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 3, 0)),
        )
        .unwrap();
        wb.set_name(
            "Vals",
            NamedTarget::Range(ql_types::Range::new(0, 0, 1, 3, 1)),
        )
        .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // MATCH("gamma", Keys, 0) = 3 (1-based position of gamma).
        let m = rt
            .set_formula(0, 0, 2, "MATCH(\"gamma\", Keys, 0)")
            .unwrap();
        assert_eq!(m, Value::Number(3.0));
        // INDEX(Vals, MATCH("gamma", Keys, 0)) = 30.
        let v = rt
            .set_formula(0, 1, 2, "INDEX(Vals, MATCH(\"gamma\", Keys, 0))")
            .unwrap();
        assert_eq!(v, Value::Number(30.0));
    }

    /// CHOOSE picks from scalar args.
    #[test]
    fn w5_54_choose_e2e() {
        use std::sync::Arc;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt
            .set_formula(0, 0, 0, "CHOOSE(3, \"a\", \"b\", \"c\", \"d\")")
            .unwrap();
        assert_eq!(v, Value::Text(Arc::from("c")));
    }

    /// VLOOKUP not-found returns #N/A. Verifies the error
    /// classification is end-to-end correct (not stuck at #VALUE!).
    #[test]
    fn w5_54_vlookup_not_found_returns_na_e2e() {
        use ql_storage::NamedTarget;
        use std::sync::Arc;
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Text(Arc::from("apple")));
        wb.put_at(0, 0, 1, Value::Number(1.0));
        wb.put_at(0, 1, 0, Value::Text(Arc::from("banana")));
        wb.put_at(0, 1, 1, Value::Number(2.0));
        wb.set_name(
            "Lookup",
            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 1, 1)),
        )
        .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt
            .set_formula(0, 0, 3, "VLOOKUP(\"zzz\", Lookup, 2, FALSE)")
            .unwrap();
        assert_eq!(v, Value::Error(ErrorValue::NA));
    }

    // ----------------------------------------------------------------
    // W5-55 — Phase 4.3 V2 conditional-aggregate completion.
    // AVERAGEIF / SUMIFS / COUNTIFS / AVERAGEIFS / SUMPRODUCT
    // end-to-end through parse → bind → eval.
    // ----------------------------------------------------------------

    /// AVERAGEIF: range [1, 2, 3, 4, 5], criteria ">2" → matches 3, 4,
    /// 5 → avg 4.
    #[test]
    fn w5_55_averageif_e2e() {
        use ql_storage::NamedTarget;
        let mut wb = make_runtime_workbook();
        for (i, v) in [1.0, 2.0, 3.0, 4.0, 5.0].iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Number(*v));
        }
        wb.set_name(
            "Vals",
            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 4, 0)),
        )
        .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 1, "AVERAGEIF(Vals, \">2\")").unwrap();
        assert_eq!(v, Value::Number(4.0));
    }

    /// SUMIFS: two label columns + value column. Sum of values where
    /// labels1="a" AND labels2="y".
    #[test]
    fn w5_55_sumifs_two_conditions_e2e() {
        use ql_storage::NamedTarget;
        use std::sync::Arc;
        let mut wb = make_runtime_workbook();
        // Col A: labels1 [a, a, b, b]
        // Col B: labels2 [x, y, x, y]
        // Col C: vals    [1, 2, 3, 4]
        let l1 = ["a", "a", "b", "b"];
        let l2 = ["x", "y", "x", "y"];
        let vals = [1.0, 2.0, 3.0, 4.0];
        for (i, ((a, b), v)) in l1.iter().zip(l2.iter()).zip(vals.iter()).enumerate() {
            wb.put_at(0, i as u32, 0, Value::Text(Arc::from(*a)));
            wb.put_at(0, i as u32, 1, Value::Text(Arc::from(*b)));
            wb.put_at(0, i as u32, 2, Value::Number(*v));
        }
        wb.set_name(
            "LabelsA",
            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 3, 0)),
        )
        .unwrap();
        wb.set_name(
            "LabelsB",
            NamedTarget::Range(ql_types::Range::new(0, 0, 1, 3, 1)),
        )
        .unwrap();
        wb.set_name(
            "Vals",
            NamedTarget::Range(ql_types::Range::new(0, 0, 2, 3, 2)),
        )
        .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt
            .set_formula(0, 0, 3, "SUMIFS(Vals, LabelsA, \"a\", LabelsB, \"y\")")
            .unwrap();
        // Only row 1 matches (a, y) → value 2.
        assert_eq!(v, Value::Number(2.0));
    }

    /// COUNTIFS: same shape, count where labels1="a".
    #[test]
    fn w5_55_countifs_single_condition_e2e() {
        use ql_storage::NamedTarget;
        use std::sync::Arc;
        let mut wb = make_runtime_workbook();
        for (i, label) in ["a", "b", "a", "c", "a"].iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Text(Arc::from(*label)));
        }
        wb.set_name(
            "Labels",
            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 4, 0)),
        )
        .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 1, "COUNTIFS(Labels, \"a\")").unwrap();
        assert_eq!(v, Value::Number(3.0));
    }

    /// SUMPRODUCT: dot-product of two columns.
    #[test]
    fn w5_55_sumproduct_two_columns_e2e() {
        use ql_storage::NamedTarget;
        let mut wb = make_runtime_workbook();
        for (i, (a, b)) in [(1.0, 10.0), (2.0, 20.0), (3.0, 30.0)].iter().enumerate() {
            wb.put_at(0, i as u32, 0, Value::Number(*a));
            wb.put_at(0, i as u32, 1, Value::Number(*b));
        }
        wb.set_name(
            "Prices",
            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 2, 0)),
        )
        .unwrap();
        wb.set_name(
            "Quantities",
            NamedTarget::Range(ql_types::Range::new(0, 0, 1, 2, 1)),
        )
        .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // 1*10 + 2*20 + 3*30 = 140.
        let v = rt
            .set_formula(0, 0, 2, "SUMPRODUCT(Prices, Quantities)")
            .unwrap();
        assert_eq!(v, Value::Number(140.0));
    }

    /// AVERAGEIFS with two conditions.
    #[test]
    fn w5_55_averageifs_e2e() {
        use ql_storage::NamedTarget;
        use std::sync::Arc;
        let mut wb = make_runtime_workbook();
        // labels1: [a, a, b]
        // labels2: [x, y, x]
        // vals:    [10, 20, 30]
        // AVERAGEIFS(vals, l1, "a", l2, "y") → row 1 only → avg 20.
        for (i, (a, b, v)) in [("a", "x", 10.0), ("a", "y", 20.0), ("b", "x", 30.0)]
            .iter()
            .enumerate()
        {
            wb.put_at(0, i as u32, 0, Value::Text(Arc::from(*a)));
            wb.put_at(0, i as u32, 1, Value::Text(Arc::from(*b)));
            wb.put_at(0, i as u32, 2, Value::Number(*v));
        }
        wb.set_name(
            "LabelsA",
            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 2, 0)),
        )
        .unwrap();
        wb.set_name(
            "LabelsB",
            NamedTarget::Range(ql_types::Range::new(0, 0, 1, 2, 1)),
        )
        .unwrap();
        wb.set_name(
            "Vals",
            NamedTarget::Range(ql_types::Range::new(0, 0, 2, 2, 2)),
        )
        .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt
            .set_formula(0, 0, 3, "AVERAGEIFS(Vals, LabelsA, \"a\", LabelsB, \"y\")")
            .unwrap();
        assert_eq!(v, Value::Number(20.0));
    }

    /// Phase 3.7 extra: `mark_volatile_dirty` on a workbook with zero
    /// volatile formulas returns 0 and leaves the dirty set empty.
    #[test]
    fn mark_volatile_dirty_zero_when_no_volatile_formulas() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = crate::CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "1 + 1").unwrap();
            rt.set_formula(0, 0, 1, "A1 * 2").unwrap();
        }
        let count = graph.mark_volatile_dirty();
        assert_eq!(count, 0);
        assert!(graph.dirty_formulas().is_empty());
    }

    /// Phase 3.4: empty dirty (e.g. recompute_dirty called twice in a
    /// row with no edits between) returns an empty result.
    #[test]
    fn recompute_dirty_twice_in_a_row_is_idempotent() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap();
            rt.set_formula(0, 0, 1, "A1 + 1").unwrap();
        }
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(2.0)).unwrap();
        let r1 = rt.recompute_dirty().unwrap();
        assert_eq!(r1.attempted, 1);
        let r2 = rt.recompute_dirty().unwrap();
        assert_eq!(r2.attempted, 0, "second call: nothing dirty");
        assert_eq!(r2.succeeded, 0);
    }

    // (Tier D1 Step 3.1: W5-82 format tests moved to formats.rs::tests.)

    // ===== W5-83 / Phase 4.5.E — TEXT() formula integration =====

    #[test]
    fn text_formula_renders_through_recompute() {
        // End-to-end: a `TEXT(serial, "yyyy-mm-dd")` formula evaluates
        // to a Text value with the rendered string.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(45477.0)); // 2024-07-04
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s, 1, 0, "TEXT(A1, \"yyyy-mm-dd\")").unwrap();
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s, 1, 0)),
            Value::text("2024-07-04")
        );
    }

    #[test]
    fn text_formula_with_number_format_returns_formatted_text() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1234.5));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s, 1, 0, "TEXT(A1, \"#,##0.00\")").unwrap();
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s, 1, 0)),
            Value::text("1,234.50")
        );
    }

    #[test]
    fn text_formula_invalid_format_returns_value_error() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // `[Red]0` is V2-deferred → parser refuses → TEXT returns #VALUE!
        rt.set_formula(s, 0, 0, "TEXT(1, \"[Red]0\")").unwrap();
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s, 0, 0)),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== W5-90 / Phase 4.6.B — cross-sheet end-to-end evaluation =====

    #[test]
    fn cross_sheet_cellref_evaluates_after_recompute() {
        // `Sheet2!A1 + 1` on Sheet1, where Sheet2!A1 = 41 → 42.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("Sheet1");
        let s2 = wb.add_sheet("Sheet2");
        wb.put_at(s2, 0, 0, Value::Number(41.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s1, 0, 0, "Sheet2!A1 + 1").unwrap();
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s1, 0, 0)),
            Value::Number(42.0)
        );
    }

    // NOTE: `SUM(Sheet2!A1:A3)` (range literal as function arg) is a
    // Phase 4.7 feature — the binder currently rejects `Expr::RangeRef`
    // outside a Function context, and only NameRef→Range pairs reach
    // the AggregateNameRef path. Cross-sheet ranges through named
    // ranges DO work; verified by the named-target tests below.

    #[test]
    fn cross_sheet_quoted_name_with_space_evaluates() {
        // Quoted-sheet-name path: `'Q3 2025'!A1 + 100`.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("Main");
        let s2 = wb.add_sheet("Q3 2025");
        wb.put_at(s2, 0, 0, Value::Number(7.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s1, 0, 0, "'Q3 2025'!A1 + 100").unwrap();
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s1, 0, 0)),
            Value::Number(107.0)
        );
    }

    #[test]
    fn cross_sheet_formula_with_unknown_sheet_surfaces_bind_error_at_set_time() {
        // `set_formula` binds eagerly so the IDE can surface syntax-time
        // errors. An unknown-sheet ref fails at bind, not at recompute.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.set_formula(s1, 0, 0, "Phantom!A1 + 1").unwrap_err();
        match err {
            RuntimeError::Bind(crate::plan::BindError::UnknownSheet(name)) => {
                assert_eq!(name.as_ref(), "Phantom");
            }
            other => panic!("expected RuntimeError::Bind(UnknownSheet), got {other:?}"),
        }
    }

    #[test]
    fn cross_sheet_three_sheet_chain_evaluates() {
        // Sheet3 reads from Sheet2 reads from Sheet1. Tests that
        // cross-sheet deps work through the calcgraph + recompute path.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        let s2 = wb.add_sheet("S2");
        let s3 = wb.add_sheet("S3");
        wb.put_at(s1, 0, 0, Value::Number(10.0)); // S1!A1 = 10
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s2, 0, 0, "S1!A1 * 2").unwrap(); // S2!A1 = 20
        rt.set_formula(s3, 0, 0, "S2!A1 + 5").unwrap(); // S3!A1 = 25
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s2, 0, 0)),
            Value::Number(20.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(s3, 0, 0)),
            Value::Number(25.0)
        );
    }

    // (Tier D1 Step 3.3: W5-91 rename_sheet tests moved to
    //  sheets.rs::tests.)

    // ===== W5-92 (Phase 4.6.D) set_sheet_scoped_name =====

    #[test]
    fn set_sheet_scoped_name_lands_on_sheet_table() {
        use ql_storage::NamedTarget;
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_sheet_scoped_name(s0, "R", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        drop(rt);
        assert!(matches!(
            wb.sheet(s0).unwrap().scoped_names().lookup_ci("R"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        // Workbook-scope is untouched.
        assert!(wb.names().is_empty());
    }

    #[test]
    fn set_sheet_scoped_name_invalid_sheet_errors() {
        use ql_storage::NamedTarget;
        let mut wb = Workbook::new();
        let _ = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .set_sheet_scoped_name(42, "R", NamedTarget::Constant(Value::Number(1.0)))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::InvalidSheet { sheet: 42, .. }));
    }

    #[test]
    fn set_sheet_scoped_name_reserved_name_rejected() {
        use ql_storage::NamedTarget;
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .set_sheet_scoped_name(s0, "AI", NamedTarget::Constant(Value::Number(42.0)))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::Name(_)));
        // Workbook unmutated.
        drop(rt);
        assert!(wb.sheet(s0).unwrap().scoped_names().is_empty());
    }

    #[test]
    fn set_sheet_scoped_name_emits_op_with_scope() {
        use ql_oplog::OpLog;
        use ql_storage::NamedTarget;
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
        rt.set_sheet_scoped_name(s0, "R", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        drop(rt);
        let ops: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::SetName {
                scope,
                name,
                target,
            } => {
                assert_eq!(*scope, Some(s0));
                assert_eq!(name, "R");
                assert!(matches!(target, ql_io::NamedTargetWire::Constant { .. }));
            }
            other => panic!("expected SetName, got {other:?}"),
        }
    }

    #[test]
    fn formula_resolves_sheet_scoped_over_workbook_scoped() {
        // End-to-end: workbook has Rate = 0.05, sheet 0 has scoped Rate = 0.21.
        // A formula `=Rate` on sheet 0 should evaluate to 0.21 (sheet-scoped
        // wins). On sheet 1 (no scoped Rate) it should evaluate to 0.05.
        use ql_storage::NamedTarget;
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        let s1 = wb.add_sheet("S1");
        wb.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
            .unwrap();
        wb.sheet_mut(s0)
            .unwrap()
            .set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v0 = rt.set_formula(s0, 0, 0, "Rate").unwrap();
        assert_eq!(v0, Value::Number(0.21));
        let v1 = rt.set_formula(s1, 0, 0, "Rate").unwrap();
        assert_eq!(v1, Value::Number(0.05));
    }

    // ===== W5-93 (Phase 4.6.E closure) =====

    #[test]
    fn add_sheet_rejects_canonical_duplicate() {
        // Codex HIGH-1: WorkbookRuntime::add_sheet must pre-validate.
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet1");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.add_sheet("SHEET1", 16).unwrap_err();
        assert!(matches!(err, RuntimeError::SheetName(_)));
        // Workbook unchanged (only the original sheet).
        drop(rt);
        assert_eq!(wb.sheet_count(), 1);
    }

    #[test]
    fn add_sheet_rejects_reserved_char() {
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.add_sheet("Bad/Sheet", 16).unwrap_err();
        assert!(matches!(err, RuntimeError::SheetName(_)));
    }

    #[test]
    fn add_sheet_with_bad_name_emits_no_oplog_entry() {
        // Pre-validation must run BEFORE the op log append so a bad
        // name doesn't leave a phantom AddSheet in the log.
        use ql_oplog::OpLog;
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet1");
        let reg = default_registry();
        let mut log = OpLog::new();
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
        let _ = rt.add_sheet("Sheet1", 16).unwrap_err();
        drop(rt);
        let ops: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(
            ops.len(),
            0,
            "no Op::AddSheet for rejected name; got {ops:?}"
        );
    }

    #[test]
    fn set_sheet_scoped_name_invalidates_plan_cache() {
        // Codex HIGH-2: a workbook-scoped formula bound BEFORE the
        // sheet-scoped name was registered must re-bind on next
        // recompute. Pre-W5-93 the plan cache key only included the
        // workbook NameTable generation, so the cached plan would
        // keep using the workbook-scoped value.
        use ql_storage::NamedTarget;
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        wb.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Bind once — `=Rate` resolves to workbook-scoped 0.05.
        let v0 = rt.set_formula(s0, 0, 0, "Rate").unwrap();
        assert_eq!(v0, Value::Number(0.05));
        // Register a sheet-scoped Rate on the same sheet.
        rt.set_sheet_scoped_name(s0, "Rate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        // Recompute — the cached plan should have been invalidated, so
        // we re-bind and pick up the sheet-scoped 0.21.
        let _ = rt.recompute_all();
        drop(rt);
        assert_eq!(
            wb.read(ql_types::Address::new(s0, 0, 0)),
            Value::Number(0.21),
            "cache invalidation: sheet-scoped value should win after registration"
        );
    }

    // ===== W5-103 (Phase 4.7.J.2) — spill writeback =====
    //
    // Tests for array formula writeback. Per design § 8.1:
    //   1. Scalar path unchanged (regression coverage above).
    //   2. Array literal at A1 → spills to A1:A1+rows-1 × A1:A1+cols-1.
    //   3. Clear-old: re-setting an array formula at the same cell
    //      first dissolves the prior spill.
    //   4. Blocking: any non-anchor target with a value/formula/anchor
    //      → anchor gets #SPILL!, no targets written.
    //   5. Bounds: anchor + shape exceeds MAX_ROW/MAX_COLUMN → anchor
    //      gets #SPILL!, no registration.

    /// Phase 4.7.J.2 — happy path: `={1,2,3}` at A1 spills 1×3 across
    /// A1, B1, C1. Return value is array.at(0,0) = 1.
    #[test]
    fn set_formula_array_literal_horizontal_spills_1x3() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        assert_eq!(v, Value::Number(1.0), "anchor return is array (0,0)");
        // All three cells materialized in the computed overlay.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
        // Anchor has formula text; non-anchors do not (design § 8.2).
        assert!(wb.formula_at(0, 0, 0).is_some());
        assert!(wb.formula_at(0, 0, 1).is_none());
        assert!(wb.formula_at(0, 0, 2).is_none());
        // Spill anchor registered.
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3))
        );
        // Reverse lookup: B1 and C1 map back to A1.
        assert_eq!(wb.spill_target_anchor(0, 0, 1), Some((0, 0, 0)));
        assert_eq!(wb.spill_target_anchor(0, 0, 2), Some((0, 0, 0)));
    }

    /// Phase 4.7.J.2 — happy path: `={1;2;3}` at A1 spills 3×1 down
    /// (vertical: semicolons are row separators per design § 3.1).
    #[test]
    fn set_formula_array_literal_vertical_spills_3x1() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "{1; 2; 3}").unwrap();
        assert_eq!(v, Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 2, 0)), Value::Number(3.0));
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(3, 1))
        );
    }

    /// Phase 4.7.J.2 — happy path: 2×2. `{1,2;3,4}` → A1=1, B1=2, A2=3, B2=4.
    #[test]
    fn set_formula_array_literal_2x2_spills() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        rt.set_formula(0, 0, 0, "{1, 2; 3, 4}").unwrap();
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(3.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 1)), Value::Number(4.0));
    }

    /// Phase 4.7.J.2 — clear-old: re-setting an array formula at the
    /// same anchor with a SMALLER shape leaves no orphan cells from
    /// the prior footprint. Per design § 8.3.
    #[test]
    fn set_formula_array_shrinks_clears_old_footprint() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // First: 3-cell horizontal spill.
        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();

        // Then: 1-cell array at the same anchor. The clear-old step
        // must dissolve the prior 1×3 footprint BEFORE evaluating
        // the new one, so the new 1×1 doesn't see its own old B1/C1
        // entries as blockers, AND B1/C1 are blank in the final state.
        rt.set_formula(0, 0, 0, "{9}").unwrap();
        drop(rt);
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(9.0));
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Blank,
            "old B1 must be cleared by clear-old"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 2)),
            Value::Blank,
            "old C1 must be cleared by clear-old"
        );
        // New shape registered; reverse map no longer points B1/C1 → A1.
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 1))
        );
        assert_eq!(wb.spill_target_anchor(0, 0, 1), None);
    }

    /// Phase 4.7.J.2 — scalar-after-array: re-setting an anchor cell
    /// with a SCALAR formula dissolves the prior spill entirely.
    #[test]
    fn set_formula_scalar_after_array_clears_spill_state() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        rt.set_formula(0, 0, 0, "42").unwrap();
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Number(42.0)
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Blank);
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Blank);
        assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
    }

    /// Phase 4.7.J.2 — blocking: B1 has a user value `=5`. Setting
    /// `={1,2}` at A1 (1×2 spill A1:B1) sees B1 occupied → anchor gets
    /// #SPILL!, no targets registered, no targets overwritten.
    #[test]
    fn set_formula_array_blocked_by_user_value_at_target() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // B1 = literal 5 (user lane).
        rt.set_value(0, 0, 1, Value::Number(5.0)).unwrap();
        // Try to spill 1×2 from A1.
        let v = rt.set_formula(0, 0, 0, "{1, 2}").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::Spill));
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Error(ErrorValue::Spill)
        );
        // B1 untouched (still holds user 5).
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(5.0));
        // No spill registered.
        assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
        // Anchor still has formula text (so re-eval after blocker clears
        // can spill correctly — design § 9.2).
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("{1, 2}"));
    }

    /// Phase 4.7.J.2 — blocking: B1 has its own formula (computed
    /// output `=10+10`). Setting `={1,2}` at A1 sees B1 occupied →
    /// anchor #SPILL!, B1's formula untouched.
    #[test]
    fn set_formula_array_blocked_by_formula_at_target() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        rt.set_formula(0, 0, 1, "10 + 10").unwrap();
        let v = rt.set_formula(0, 0, 0, "{1, 2}").unwrap();
        assert_eq!(v, Value::Error(ErrorValue::Spill));
        // B1 still holds its own formula's output.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(20.0)
        );
        assert_eq!(
            wb.formula_at(0, 0, 1).map(|s| s.as_ref()),
            Some("10 + 10"),
            "B1's formula must NOT be removed by a blocked spill"
        );
        assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
    }

    /// Phase 4.7.J.2 — out-of-bounds spill: anchor at MAX_ROW with a
    /// 3-row vertical array → end_row exceeds grid → anchor #SPILL!.
    #[test]
    fn set_formula_array_out_of_bounds_returns_spill() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Anchor at the LAST row in the grid. `{1;2;3}` would need
        // 3 rows starting from MAX_ROW → out of bounds.
        let v = rt.set_formula(0, MAX_ROW, 0, "{1; 2; 3}");
        // Anchor cell validation passes (MAX_ROW is in range). Eval
        // produces ArrayValue. Bounds check at writeback fails.
        assert_eq!(v.unwrap(), Value::Error(ErrorValue::Spill));
        drop(rt);
        assert_eq!(wb.spill_anchor_at(0, MAX_ROW, 0), None);
    }

    // ===== W5-103 (Phase 4.7.J.3) — target-cell calcgraph invalidation =====

    /// Phase 4.7.J.3 — happy path: writeback fires `on_set_value` once
    /// per NON-ANCHOR target cell. A 1×3 spill at A1 fires for B1 and
    /// C1, NOT for A1 (anchor is covered by on_set_formula's internal
    /// `mark_dirty_from_cell_write`).
    ///
    /// Verified by hook counters: set_value fires twice (B1, C1) on
    /// top of whatever set_value counter was at before the spill.
    #[test]
    fn set_formula_array_writeback_fires_on_set_value_for_each_target() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        }
        let counts = graph.hook_counts();
        assert_eq!(
            counts.set_value, 2,
            "1x3 spill must fire on_set_value for B1 and C1 only (anchor excluded)"
        );
        assert_eq!(counts.set_formula, 1, "anchor's set_formula hook fired");
    }

    /// Phase 4.7.J.3 — 2x2 spill fires `on_set_value` three times
    /// (A1=anchor, B1, A2, B2 — three non-anchor cells).
    #[test]
    fn set_formula_array_2x2_fires_three_on_set_value() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1, 2; 3, 4}").unwrap();
        }
        let counts = graph.hook_counts();
        assert_eq!(
            counts.set_value, 3,
            "2x2 spill: B1, A2, B2 → 3 non-anchor cells"
        );
    }

    /// Phase 4.7.J.3 — pre-existing reader of an OLD target dirties
    /// when the spill DISSOLVES (anchor changes from array to scalar).
    /// This is the OLD-footprint case: clearing the spill at A1 must
    /// fire `on_set_value` for A2, A3 so a B1=A2 reader notices that
    /// A2 is now Blank and re-evaluates.
    #[test]
    fn set_formula_dissolving_spill_dirties_old_target_readers() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            // Spill A1:A1+3 horizontally.
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
            // Reader at D1 = B1 (target of the spill).
            rt.set_formula(0, 0, 3, "B1").unwrap();
        }
        // After the reader is bound, the spill is active. D1's dep
        // got producer-aliased to A1 (4.7.I).
        let pre_dissolve = graph.hook_counts().set_value;

        // Now dissolve the spill by re-setting A1 to a scalar.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "42").unwrap();
        }
        let post_dissolve = graph.hook_counts().set_value;
        // The dissolution fires on_set_value for B1 and C1 (the OLD
        // footprint's non-anchor cells). pre-existing readers indexed
        // under those cells get dirtied via the cell-to-formulas
        // reverse index.
        assert_eq!(
            post_dissolve - pre_dissolve,
            2,
            "dissolution must fire on_set_value for B1 and C1 (old footprint)"
        );
    }

    /// Phase 4.7.J.3 — a re-spill of DIFFERENT shape fires
    /// `on_set_value` for the UNION of old and new footprints
    /// (excluding the anchor), each cell only ONCE. Tests the
    /// HashSet-based dedupe.
    #[test]
    fn set_formula_array_reshape_fires_on_set_value_for_union() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            // First: 1x3 (A1, B1, C1).
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        }
        let after_first = graph.hook_counts().set_value;

        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            // Second: 3x1 (A1, A2, A3). Union with prior {A1,B1,C1}
            // minus anchor = {B1, C1, A2, A3}. 4 cells.
            rt.set_formula(0, 0, 0, "{4; 5; 6}").unwrap();
        }
        let after_second = graph.hook_counts().set_value;
        assert_eq!(
            after_second - after_first,
            4,
            "reshape from 1x3 to 3x1 fires on_set_value 4 times: union {{B1,C1,A2,A3}}"
        );
    }

    /// Phase 4.7.J.3 — blocked spill DOES NOT fire `on_set_value` at
    /// non-existent target cells (because no new footprint is
    /// registered). The OLD footprint cells still fire if there was
    /// a prior spill at this anchor.
    #[test]
    fn set_formula_blocked_spill_does_not_fire_target_hooks() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        // First put a user value at B1 to block the spill.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 1, Value::Number(5.0)).unwrap();
        }
        let baseline = graph.hook_counts().set_value;
        // Now try to spill 1x2 from A1. Blocked.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let v = rt.set_formula(0, 0, 0, "{1, 2}").unwrap();
            assert_eq!(v, Value::Error(ErrorValue::Spill));
        }
        let after = graph.hook_counts().set_value;
        assert_eq!(
            after - baseline,
            0,
            "blocked spill must NOT fire on_set_value at B1 (no new footprint, no old footprint either)"
        );
    }

    // ===== Phase 4.7.J.2 (continued) — clear-old idempotency =====

    /// Phase 4.7.J.2 — clear-old idempotency: setting the SAME array
    /// twice at the same anchor produces stable state (no infinite
    /// re-spill, no self-blocking).
    #[test]
    fn set_formula_array_same_formula_twice_is_stable() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        let v = rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        assert_eq!(v, Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3))
        );
    }

    // ===== W5-103 (Phase 4.7.J.4) — register_spill re-extraction =====
    //
    // Closes Codex W5-102 HIGH-1: when a reader formula is bound BEFORE
    // the spill at its dep cell registers, the reader's cell-dep is
    // indexed under the target cell and no graph edge to the anchor
    // exists. Tarjan ordering can then schedule the reader BEFORE the
    // anchor, reading a stale value. The re-extraction trigger in
    // `set_formula` walks readers in the new footprint and re-runs
    // dep extraction so the producer-alias rewrite fires.

    /// Phase 4.7.J.4 — the canonical HIGH-1 scenario:
    /// 1. Bind reader B1 = A2 (no spill yet at A1; B1's dep is (0,1,0)).
    /// 2. Set A1 = `{1, 2, 3}` (spills to A1, B1, C1).
    ///
    /// Wait — A1's spill goes HORIZONTAL across A1, B1, C1, not vertical.
    /// To put a target at A2, we need a VERTICAL spill: A1 = `{1;2;3}`
    /// spills to A1, A2, A3. Then B1 = A2 reads target A2.
    ///
    /// After the spill registers, B1's dep MUST be (0,0,0) (the anchor)
    /// and the graph MUST have a B1 → A1 edge.
    #[test]
    fn set_formula_reextract_aliases_pre_existing_reader_to_anchor() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            // B1 = A2 — bound BEFORE any spill exists. Dep recorded at A2.
            rt.set_formula(0, 0, 1, "A2").unwrap();
        }
        let b1_node = graph.cell_node_for(0, 0, 1).unwrap();
        // Pre-spill: B1's dep is the literal target cell.
        assert_eq!(
            graph.formula_deps(b1_node).unwrap().cells,
            vec![(0, 1, 0)],
            "pre-spill: B1 depends on A2 literally"
        );

        // Now A1 spills vertically over A1, A2, A3.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1; 2; 3}").unwrap();
        }
        let a1_node = graph.cell_node_for(0, 0, 0).unwrap();
        // Post-spill: B1's dep got re-aliased to the anchor.
        assert_eq!(
            graph.formula_deps(b1_node).unwrap().cells,
            vec![(0, 0, 0)],
            "post-spill: B1's dep rewritten to the anchor A1 (4.7.J.4 re-extraction)"
        );
        // Graph edge B1 → A1 materialized.
        assert!(
            graph.graph().outgoing(b1_node).contains(&a1_node),
            "graph edge B1 → A1 must exist after re-extraction"
        );
    }

    /// Phase 4.7.J.4 — dissolution case: a reader bound AFTER the spill
    /// gets aliased to the anchor. When the spill dissolves, the alias
    /// must be re-routed back to the underlying target cell.
    #[test]
    fn set_formula_reextract_unroutes_alias_after_spill_dissolves() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        // 1. Spill at A1 first.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1; 2; 3}").unwrap();
            // 2. Then reader B1 = A2 — gets aliased to A1.
            rt.set_formula(0, 0, 1, "A2").unwrap();
        }
        let b1 = graph.cell_node_for(0, 0, 1).unwrap();
        assert_eq!(
            graph.formula_deps(b1).unwrap().cells,
            vec![(0, 0, 0)],
            "B1 aliased to anchor while spill active"
        );

        // 3. Dissolve spill — set A1 to scalar.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "42").unwrap();
        }
        // B1's dep should now be re-routed back to the literal A2.
        assert_eq!(
            graph.formula_deps(b1).unwrap().cells,
            vec![(0, 1, 0)],
            "post-dissolution: B1's dep restored to A2 (no longer aliased)"
        );
    }

    /// Phase 4.7.J.4 — dedupe across the union: a reader at (0,0,4)
    /// whose dep is in BOTH old (B1, prior shape 1×3) and new (B1, new
    /// shape 1×4) footprints should be re-extracted ONCE, not twice.
    /// We assert via the formula_deps content + a hook counter check
    /// would be ideal but extract_and_register_deps doesn't have a
    /// dedicated counter; we instead verify the final dep state is
    /// correct.
    #[test]
    fn set_formula_reextract_dedupes_across_old_and_new_footprint() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            // A1 spills 1×3 (A1, B1, C1).
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
            // E1 = B1 — aliased to A1.
            rt.set_formula(0, 0, 4, "B1").unwrap();
        }
        let e1 = graph.cell_node_for(0, 0, 4).unwrap();
        assert_eq!(graph.formula_deps(e1).unwrap().cells, vec![(0, 0, 0)]);

        // Re-set A1 to a wider spill (1×4, A1..D1). B1 is in both
        // old AND new footprint. E1 = B1 must STILL be aliased to A1.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1, 2, 3, 4}").unwrap();
        }
        assert_eq!(
            graph.formula_deps(e1).unwrap().cells,
            vec![(0, 0, 0)],
            "E1 stays aliased to A1 after reshape; re-extraction is idempotent"
        );
    }

    /// Phase 4.7.J.4 — blocked spill case: when a writeback returns
    /// #SPILL! (no new footprint registered), no NEW-footprint readers
    /// need re-extraction (only OLD-footprint, if any). Verify by
    /// blocking a spill that has no prior footprint AND a pre-existing
    /// reader at the would-be target.
    #[test]
    fn set_formula_reextract_skipped_on_blocked_spill_with_no_old_footprint() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            // C1 = B1 — pre-existing reader of B1 (no spill yet anywhere).
            rt.set_formula(0, 0, 2, "B1").unwrap();
            // B1 user-blocks the spill.
            rt.set_value(0, 0, 1, Value::Number(99.0)).unwrap();
            // Try to spill 1×2 at A1: A1, B1. Blocked by B1's user value.
            rt.set_formula(0, 0, 0, "{1, 2}").unwrap();
        }
        let c1 = graph.cell_node_for(0, 0, 2).unwrap();
        // No new footprint registered → C1's dep stays on (0,0,1) (B1).
        assert_eq!(
            graph.formula_deps(c1).unwrap().cells,
            vec![(0, 0, 1)],
            "blocked spill leaves C1's dep untouched"
        );
    }

    // ===== W5-103 (Phase 4.7.J.5) — set_formula at spill target =====
    //
    // Codex W5-102 MEDIUM-3: typing a formula into a spill TARGET cell
    // (not its anchor) must dissolve the host spill. Per design § 10.2:
    // the host's anchor formula stays put; next recompute at the host
    // sees this cell as a blocker and emits #SPILL!.

    /// Phase 4.7.J.5 — happy path: A1 anchors a 1×3 spill (A1, B1, C1).
    /// Then set a scalar formula at B1. Result: host spill dissolved
    /// (B1's value is the new formula; A2/A3 — wait this is horizontal,
    /// so A1=1, B1=2, C1=3 originally. After dissolving + setting B1=99:
    /// host spill gone, A1 still has formula text, B1 = 99, C1 = Blank.
    #[test]
    fn set_formula_at_spill_target_dissolves_host_spill() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Spill 1x3 from A1.
        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        // Write a formula at B1 — dissolves the host spill at A1.
        rt.set_formula(0, 0, 1, "99 + 1").unwrap();
        drop(rt);

        // Host spill no longer registered.
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0),
            None,
            "host spill at A1 must be dissolved"
        );
        // B1 has its own formula now.
        assert_eq!(wb.formula_at(0, 0, 1).map(|s| s.as_ref()), Some("99 + 1"));
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(100.0)
        );
        // C1 was a target — its computed value got cleared by
        // clear_spill_at when the host dissolved.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Blank);
        // A1 still holds the anchor formula text (re-eval on next
        // recompute will emit #SPILL! per design § 9.2).
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("{1, 2, 3}")
        );
    }

    /// Phase 4.7.J.5 — anchor cell is NOT treated as a "target" by the
    /// dissolution check. Setting a formula at the anchor follows the
    /// existing clear-old path (4.7.J.2 MEDIUM-4 closure), not the new
    /// MEDIUM-3 dissolution path. Verifies that writing a NEW array at
    /// the same anchor reshapes correctly without spuriously calling
    /// clear_spill_at twice (which would error the second time).
    #[test]
    fn set_formula_at_anchor_does_not_double_clear_spill() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        // Re-set at anchor — the MEDIUM-3 path sees A1 is both anchor
        // AND target of itself; the `host_anchor != (sheet, row, col)`
        // guard prevents a double-clear. Then clear_spill_if_present
        // dissolves the old footprint.
        rt.set_formula(0, 0, 0, "{4; 5}").unwrap();
        drop(rt);

        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(2, 1))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(4.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(5.0));
        // Old B1 and C1 cleared.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Blank);
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Blank);
    }

    /// Phase 4.7.J.5 — array formula INTO a spill target also dissolves
    /// the host AND can register a NEW spill rooted at the target cell.
    /// (Excel canon: typing IS allowed, dissolution propagates.)
    #[test]
    fn set_formula_array_at_spill_target_dissolves_then_spills() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // First spill at A1 (horizontal, A1, B1, C1).
        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        // Now set an array formula at B1 — dissolves A1's spill, then
        // tries to spill at B1. A 1×2 from B1 = B1, C1. The dissolution
        // clears B1's and C1's prior computed values, so the new spill
        // sees them as Blank → succeeds.
        rt.set_formula(0, 0, 1, "{7, 8}").unwrap();
        drop(rt);

        // Host A1's spill dissolved.
        assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
        // B1 is now an anchor for a new 1×2 spill.
        assert_eq!(
            wb.spill_anchor_at(0, 0, 1).copied(),
            Some(ql_storage::SpillShape::new(1, 2))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(7.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(8.0));
    }

    /// Phase 4.7.J.5 — non-target write is unaffected by the
    /// dissolution check (negative control: no spurious clear when
    /// the target cell isn't part of any spill).
    #[test]
    fn set_formula_at_non_spill_target_unchanged_behavior() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // A1 spills A1..C1.
        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        // Write a formula at D1 (NOT a target).
        let v = rt.set_formula(0, 0, 3, "10 + 10").unwrap();
        drop(rt);

        assert_eq!(v, Value::Number(20.0));
        // Host spill still active.
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Number(20.0)
        );
    }

    // ===== W5-103 megaudit HIGH-1 — host-spill dissolution side-effects =====
    //
    // When set_formula writes into a non-anchor target of someone
    // else's spill (J.5 path), the host's footprint must feed into
    // the on_set_value + re-extract passes too. Otherwise readers of
    // OTHER host targets don't dirty, host-aliased readers stay
    // routed to the dissolved anchor, and the host anchor's own
    // NodeId is never marked dirty (so recompute_dirty leaves it
    // indefinitely stale).

    /// Host A1 spills A1..C1. Reader D1 = C1 (aliased to A1 by 4.7.I).
    /// User sets B1 = 99 (scalar formula) → J.5 dissolves A1's spill.
    /// After dissolution, D1's dep must be RE-EXTRACTED (no longer
    /// aliased — A1 isn't a spill anchor anymore; D1 should reference
    /// C1 literally).
    #[test]
    fn set_formula_into_host_target_reextracts_aliased_readers() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            // A1 spills A1..C1.
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
            // D1 = C1. Aliased to A1 via 4.7.I producer-alias.
            rt.set_formula(0, 0, 3, "C1").unwrap();
        }
        let d1 = graph.cell_node_for(0, 0, 3).unwrap();
        assert_eq!(
            graph.formula_deps(d1).unwrap().cells,
            vec![(0, 0, 0)],
            "D1 starts aliased to host anchor A1"
        );

        // User sets B1 = 99 (formula) — J.5 dissolves A1's spill.
        // D1's alias dep must be re-extracted to point at C1 literally.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 1, "99").unwrap();
        }
        assert_eq!(
            graph.formula_deps(d1).unwrap().cells,
            vec![(0, 0, 2)],
            "D1's dep must be re-extracted to literal C1 after host dissolution"
        );
    }

    /// Host A1 spills A1..C1. User sets B1 = 5 — J.5 dissolves A1.
    /// The host anchor A1's NodeId must be in the dirty set so the
    /// next recompute_dirty re-evaluates A1's formula and produces
    /// #SPILL!. Without this, A1 stays stale indefinitely in
    /// incremental mode.
    #[test]
    fn set_formula_into_host_target_marks_host_anchor_dirty() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        }
        let a1 = graph.cell_node_for(0, 0, 0).unwrap();
        // Clear residue dirty from the first set_formula.
        let _ = graph.take_dirty();
        // Now set B1 = 5 — dissolves host A1.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 1, "5").unwrap();
        }
        assert!(
            graph.is_dirty(a1),
            "host anchor A1's NodeId must be dirty after J.5 dissolution \
             so recompute_dirty re-evaluates and emits #SPILL!"
        );
    }

    /// Host A1 spills A1..C1. Reader X1 = B1 (also aliased to A1).
    /// User sets C1 = 5 — J.5 dissolves A1. X1 (a reader of a
    /// DIFFERENT host-target cell) must dirty too, because B1's
    /// spilled value is gone.
    #[test]
    fn set_formula_into_host_target_dirties_readers_of_other_host_targets() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
            // X1 (row 0, col 23) = B1. Aliased to A1.
            rt.set_formula(0, 0, 23, "B1").unwrap();
        }
        let x1 = graph.cell_node_for(0, 0, 23).unwrap();
        // Clear residue dirty.
        let _ = graph.take_dirty();
        // Set C1 = 5 — dissolves host A1.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 2, "5").unwrap();
        }
        // X1 references B1 which lost its spilled value. Must dirty.
        // The on_set_value pass at host footprint addresses (A1, B1)
        // fires for B1 → cell_to_formulas[(0,0,1)] should contain X1
        // (post re-extract X1's dep was at (0,0,0) the anchor; pre
        // re-extract, the on_set_value at B1 dirties via the stale
        // pre-alias index if it existed).
        //
        // More robust check: after re-extraction, X1's dep should be
        // (0,0,1) literally. AND X1 should be dirty.
        assert_eq!(
            graph.formula_deps(x1).unwrap().cells,
            vec![(0, 0, 1)],
            "X1's dep re-extracted to literal B1 (no longer aliased)"
        );
        assert!(
            graph.is_dirty(x1),
            "X1 must dirty: its dep target B1 lost its spilled value"
        );
    }

    // ===== W5-103 megaudit MEDIUM-4 — clear_formula on spill anchor =====
    //
    // Per design § 10.3: clearing the formula at a spill anchor must
    // dissolve the spill first. Otherwise SpillAnchorTable retains
    // dangling anchor + target entries and the targets' computed
    // overlays survive as orphan values.

    /// Closes the design § 10.3 gap: clear_formula at A1 (spill anchor)
    /// must dissolve A1's 1×3 spill, clearing B1/C1 computed overlays
    /// and removing the anchor + target entries.
    #[test]
    fn clear_formula_at_spill_anchor_dissolves_spill() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Spill 1x3 from A1.
        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        // Clear the formula at A1.
        rt.clear_formula(0, 0, 0).unwrap();
        drop(rt);

        // Anchor table cleaned.
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0),
            None,
            "anchor must be removed from SpillAnchorTable"
        );
        assert_eq!(
            wb.spill_target_anchor(0, 0, 1),
            None,
            "B1 must no longer map back to A1"
        );
        assert_eq!(
            wb.spill_target_anchor(0, 0, 2),
            None,
            "C1 must no longer map back to A1"
        );
        // Anchor cell: formula gone, A1 also becomes Blank. Excel
        // canon: deleting a spill-anchor formula removes the entire
        // spill, INCLUDING the anchor — the anchor's value came from
        // the spilled array's (0,0) slot, not from a scalar formula
        // result. clear_formula's "preserve current value as user
        // overlay" path skips because current_value is Blank by the
        // time it's captured (dissolution cleared the anchor's computed
        // overlay first). This is the correct semantic: spill anchors
        // don't retain a value after deletion the way scalar formulas
        // do.
        assert!(wb.formula_at(0, 0, 0).is_none(), "A1 formula text gone");
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Blank,
            "A1 must be Blank after spill anchor's formula is cleared (Excel canon)"
        );
        // Target cells: computed overlays cleared by clear_spill_at.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Blank,
            "B1 (spill target) must be Blank after dissolution"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 2)),
            Value::Blank,
            "C1 (spill target) must be Blank after dissolution"
        );
    }

    /// Clear at a non-anchor cell (no spill anchored there) — original
    /// clear_formula behavior preserved. Negative control.
    #[test]
    fn clear_formula_at_non_anchor_cell_unchanged_behavior() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Spill at A1, set unrelated formula at D1.
        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        rt.set_formula(0, 0, 3, "10 + 10").unwrap();
        // Clear D1 — A1's spill must be untouched.
        rt.clear_formula(0, 0, 3).unwrap();
        drop(rt);

        // A1's spill still active.
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
        // D1: formula gone, value preserved on user lane (existing semantic).
        assert!(wb.formula_at(0, 0, 3).is_none());
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Number(20.0)
        );
    }

    /// **Sonnet megaudit follow-up** — clear_formula at a spill anchor
    /// must emit exactly ONE op (ClearFormula), no spurious PutValue
    /// for the array.at(0,0) value. Pins the spill-anchor branch's
    /// op-log payload AND verifies the new atomicity ordering (op-log
    /// append happens BEFORE clear_spill_at).
    #[test]
    fn clear_formula_at_spill_anchor_emits_only_clear_formula_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // Anchor A1 spills 1×3.
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
            // Clear A1 — should emit ONLY ClearFormula (no PutValue
            // for the Number(1.0) array.at(0,0) value).
            rt.clear_formula(0, 0, 0).unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // 1 PutFormula + 1 ClearFormula = 2 ops total. No PutValue.
        assert_eq!(ops.len(), 2);
        assert!(
            matches!(ops[0], Op::PutFormula { .. }),
            "first op is the original PutFormula"
        );
        match &ops[1] {
            Op::ClearFormula { sheet, row, col } => {
                assert_eq!((*sheet, *row, *col), (0, 0, 0));
            }
            other => panic!(
                "clear_formula at spill anchor must emit Op::ClearFormula \
                 (no PutValue), got {other:?}"
            ),
        }
    }

    /// Closes design § 10.3 dirty-propagation: clear_formula at an
    /// anchor must fire on_set_value for each non-anchor cell in the
    /// dissolved footprint, so readers indexed under those addresses
    /// dirty for next recompute.
    #[test]
    fn clear_formula_at_spill_anchor_fires_on_set_value_for_targets() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        }
        let baseline = graph.hook_counts().set_value;
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.clear_formula(0, 0, 0).unwrap();
        }
        let after = graph.hook_counts().set_value;
        // 2 non-anchor cells in the 1x3 footprint → 2 on_set_value calls.
        assert_eq!(
            after - baseline,
            2,
            "clear_formula at 1x3 anchor must fire on_set_value for B1 and C1"
        );
    }

    /// **W5-108 (Phase 4.7.O) — Codex HIGH BLOCKER closure**:
    /// `clear_formula` at a spill anchor must re-extract producer-
    /// aliased readers so their deps re-route back to literal cell
    /// addresses. Mirrors `set_value_at_spill_target_reextracts_aliased_readers`
    /// but drives via `clear_formula(anchor)` instead.
    ///
    /// Pre-fix: clear_formula fired `on_set_value` for old targets but
    /// skipped `reextract_spill_footprint_readers`. A reader `X1=B1`
    /// (where B1 was a spill target of A1) kept its dep on A1 — a
    /// later `set_value(B1, 5)` would NOT dirty X1 because X1's graph
    /// dep no longer matched B1.
    #[test]
    fn clear_formula_at_spill_anchor_reextracts_aliased_readers() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
            // X1 = B1 (literal target ref). Producer-alias rewrites
            // dep to anchor A1.
            rt.set_formula(0, 0, 23, "B1").unwrap();
        }
        let x1 = graph.cell_node_for(0, 0, 23).unwrap();
        assert_eq!(
            graph.formula_deps(x1).unwrap().cells,
            vec![(0, 0, 0)],
            "X1 starts aliased to anchor A1 via producer-alias"
        );
        let _ = graph.take_dirty();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.clear_formula(0, 0, 0).unwrap();
        }
        // After clear, X1's dep must be re-extracted to literal B1
        // (now Blank). Without the 4.7.O fix, X1's dep would stay on
        // (0, 0, 0) (anchor A1), which is no longer a valid producer.
        assert_eq!(
            graph.formula_deps(x1).unwrap().cells,
            vec![(0, 0, 1)],
            "X1's dep re-extracted to literal B1 after anchor cleared"
        );
        assert!(
            graph.is_dirty(x1),
            "X1 must be dirty: its dep target dissolved"
        );
    }

    // ===== W5-103 megaudit HIGH-2 — recompute paths spill correctly =====
    //
    // Closes the all-3-reviewer-confirmed HIGH that op-log replay
    // + recompute_all collapsed spilled formulas to #CALC! because
    // the recompute path went through `eval_scalar_with_cache`
    // directly. With the cell-boundary refactor, recompute now
    // dispatches Array results through `write_spill`, materializing
    // the full footprint on every recompute pass.

    /// HIGH-2 acceptance: op-log replay of `PutFormula { text:
    /// "{1, 2, 3}" }` followed by `recompute_all` MUST produce the
    /// spill, not `#CALC!`. This is the canonical persistence
    /// round-trip — the design § 7.3 / § 12.3 "load → recompute
    /// re-derives spills" contract.
    #[test]
    fn recompute_all_materializes_spill_for_array_formula() {
        let mut wb = make_runtime_workbook();
        // Simulate the post-replay state: formula text installed, no
        // computed values, no spill anchor entry. (Op::PutFormula's
        // replay handler at crates/ql-oplog/src/replay.rs only sets
        // the formula text; recompute is left to the caller.)
        wb.put_formula(0, 0, 0, "{1, 2, 3}");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.recompute_all();
        drop(rt);
        assert_eq!(result.attempted, 1);
        assert_eq!(result.succeeded, 1);
        assert!(result.failures.is_empty());

        // Spill registered + targets materialized.
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3)),
            "recompute_all must register the spill anchor"
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
    }

    /// recompute_all on a SCALAR formula keeps its existing behavior
    /// — pre-fix this case used `eval_scalar_with_cache` directly,
    /// which is what the refactor preserves for non-Array results.
    /// Regression check.
    #[test]
    fn recompute_all_scalar_formula_unchanged() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        wb.put_formula(0, 1, 0, "A1 * 2");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        drop(rt);
        assert_eq!(result.succeeded, 1);
        assert_eq!(
            wb.read(ql_types::Address::new(0, 1, 0)),
            Value::Number(20.0)
        );
    }

    /// recompute_all on an array formula that would spill out of
    /// bounds writes #SPILL! at the anchor — same as set_formula's
    /// bounds-check arm. Pre-fix this case produced #CALC! too
    /// (silent corruption); post-fix it produces #SPILL!.
    #[test]
    fn recompute_all_out_of_bounds_spill_writes_spill_error() {
        let mut wb = make_runtime_workbook();
        // Anchor at MAX_ROW with 3-row vertical array → out of bounds.
        wb.put_formula(0, MAX_ROW, 0, "{1; 2; 3}");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        drop(rt);
        assert_eq!(result.succeeded, 1);
        assert_eq!(
            wb.read(ql_types::Address::new(0, MAX_ROW, 0)),
            Value::Error(ErrorValue::Spill)
        );
        assert_eq!(wb.spill_anchor_at(0, MAX_ROW, 0), None);
    }

    /// Re-run of recompute_all on an already-spilled formula must
    /// be idempotent: the spill stays registered with the same
    /// shape, the target values match. Validates that
    /// `clear_spill_if_present` inside the recompute path correctly
    /// dissolves the old footprint before re-spilling.
    #[test]
    fn recompute_all_array_formula_idempotent_across_two_passes() {
        let mut wb = make_runtime_workbook();
        wb.put_formula(0, 0, 0, "{1, 2, 3}");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.recompute_all();
        rt.recompute_all();
        drop(rt);
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
    }

    // ===== W5-104 (Phase 4.7.K) — set_value spill invalidation =====
    //
    // Per design § 10.2 (immediate-dissolve variant, matching
    // set_formula's 4.7.J.5): typing a literal value into a spill
    // target cell dissolves the host spill; typing into a spill
    // anchor cell dissolves its own spill.

    /// set_value at a spill TARGET cell dissolves the host spill.
    /// A1 spills A1..C1; user types `5` at B1. After: host spill
    /// gone, B1 = 5, C1 = Blank, A1 still has formula text "{1,2,3}"
    /// (re-eval at next recompute emits #SPILL!).
    #[test]
    fn set_value_at_spill_target_dissolves_host_spill() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        rt.set_value(0, 0, 1, Value::Number(5.0)).unwrap();
        drop(rt);

        assert_eq!(wb.spill_anchor_at(0, 0, 0), None, "host spill dissolved");
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Blank);
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(5.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Blank);
        // Anchor formula text preserved.
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("{1, 2, 3}")
        );
    }

    /// set_value at a spill ANCHOR cell dissolves its own spill.
    /// A1 spills A1..C1; user types `99` at A1. After: spill gone,
    /// A1 = 99 (user lane), B1 = Blank, C1 = Blank, A1 has no
    /// formula text anymore.
    #[test]
    fn set_value_at_spill_anchor_dissolves_own_spill() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        rt.set_value(0, 0, 0, Value::Number(99.0)).unwrap();
        drop(rt);

        assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Number(99.0)
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Blank);
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Blank);
        // Formula text removed (set_value over a formula clears the formula).
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// Negative control: set_value at a cell that isn't part of any
    /// spill behaves exactly as before this commit.
    #[test]
    fn set_value_at_non_spill_cell_unchanged() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        // D1 is outside A1's 1×3 footprint.
        rt.set_value(0, 0, 3, Value::Number(99.0)).unwrap();
        drop(rt);

        // Host spill still active.
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Number(99.0)
        );
    }

    /// set_value at spill target marks the host anchor's NodeId dirty
    /// so recompute_dirty re-evaluates and produces #SPILL!. Mirrors
    /// 4.7.J #127 host-anchor-dirty test.
    #[test]
    fn set_value_at_spill_target_marks_host_anchor_dirty() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
        }
        let a1 = graph.cell_node_for(0, 0, 0).unwrap();
        let _ = graph.take_dirty();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 1, Value::Number(5.0)).unwrap();
        }
        assert!(
            graph.is_dirty(a1),
            "host anchor A1 must be dirty after set_value at target B1"
        );
    }

    /// set_value at spill target re-extracts readers aliased to the
    /// host anchor. X1 = C1 was aliased to A1 via 4.7.I; after
    /// set_value at B1 dissolves A1's spill, X1's dep should be
    /// re-extracted to literal (0,0,2) and X1 should be dirty.
    #[test]
    fn set_value_at_spill_target_reextracts_aliased_readers() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
            rt.set_formula(0, 0, 23, "C1").unwrap(); // X1 = C1, aliased to A1
        }
        let x1 = graph.cell_node_for(0, 0, 23).unwrap();
        assert_eq!(
            graph.formula_deps(x1).unwrap().cells,
            vec![(0, 0, 0)],
            "X1 starts aliased to host anchor A1"
        );
        let _ = graph.take_dirty();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 1, Value::Number(5.0)).unwrap();
        }
        // X1's dep re-extracted to literal C1.
        assert_eq!(
            graph.formula_deps(x1).unwrap().cells,
            vec![(0, 0, 2)],
            "X1's dep re-extracted to literal C1 after host dissolution"
        );
        assert!(
            graph.is_dirty(x1),
            "X1 must be dirty after re-extraction (dep moved)"
        );
    }

    /// set_value over an existing formula at a spill anchor — fires
    /// BOTH the spill dissolution AND the formula-clearing path. The
    /// op-log should record PutValue + ClearFormula in a BatchCommit.
    #[test]
    fn set_value_over_spill_anchor_formula_emits_batch_commit() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_formula(0, 0, 0, "{1, 2, 3}").unwrap();
            rt.set_value(0, 0, 0, Value::Number(42.0)).unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 2, "PutFormula + BatchCommit");
        match &ops[1] {
            Op::BatchCommit { ops: batch } => {
                assert_eq!(batch.len(), 2);
                assert!(matches!(batch[0], Op::PutValue { .. }));
                assert!(matches!(batch[1], Op::ClearFormula { .. }));
            }
            other => panic!("expected BatchCommit, got {other:?}"),
        }
    }

    // ===== W5-106 (Phase 4.7.M) — SEQUENCE through set_formula =====

    /// `=SEQUENCE(3)` at A1 spills 3×1 vertically (A1, A2, A3).
    #[test]
    fn set_formula_sequence_rows_only_spills_vertically() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 0, "SEQUENCE(3)").unwrap();
        drop(rt);

        assert_eq!(v, Value::Number(1.0), "anchor return value");
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(3, 1))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 2, 0)), Value::Number(3.0));
    }

    /// `=SEQUENCE(2, 3)` at A1 spills 2×3 (A1..C2).
    #[test]
    fn set_formula_sequence_rows_cols_spills_2d() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "SEQUENCE(2, 3)").unwrap();
        drop(rt);

        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(2, 3))
        );
        // Row 0: 1, 2, 3.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
        // Row 1: 4, 5, 6.
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(4.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 1)), Value::Number(5.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 2)), Value::Number(6.0));
    }

    /// `=SEQUENCE(0)` → scalar `#NUM!` per design § 13.1 (W5-108 /
    /// Phase 4.7.O Codex M2 closure). Pre-fix returned a degenerate
    /// ArrayValue which write_spill mapped to `#CALC!`; design says
    /// Excel canon is `#NUM!` for `rows < 1`.
    #[test]
    fn set_formula_sequence_zero_rows_produces_num_error() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 0, "SEQUENCE(0)").unwrap();
        drop(rt);
        assert_eq!(v, Value::Error(ErrorValue::Num));
        assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
    }

    /// `=SEQUENCE(3)` after replay + recompute_all re-derives the spill.
    /// This is THE 4.7.J #128 acceptance — recompute_all dispatches
    /// the SEQUENCE function as Array.
    #[test]
    fn recompute_all_materializes_sequence_spill() {
        let mut wb = make_runtime_workbook();
        wb.put_formula(0, 0, 0, "SEQUENCE(3)");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        drop(rt);

        assert_eq!(result.attempted, 1);
        assert_eq!(result.succeeded, 1);
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(3, 1))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 2, 0)), Value::Number(3.0));
    }

    /// `=SEQUENCE(3) + 1` (scalar context, not at cell boundary) → #CALC!
    /// The outer `+ 1` makes SEQUENCE evaluate in scalar-sub-expression
    /// context; the FunctionReturn::Array routes to #CALC! per design
    /// § 6.3. End-to-end through set_formula.
    #[test]
    fn set_formula_sequence_inside_binary_op_produces_calc_error() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 0, "SEQUENCE(3) + 1").unwrap();
        drop(rt);
        assert_eq!(v, Value::Error(ErrorValue::Calc));
        assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
    }

    // ===== W5-107 (Phase 4.7.N.1) — TRANSPOSE end-to-end =====

    /// `=TRANSPOSE({1, 2, 3})` at A1 spills 3×1 vertically.
    #[test]
    fn set_formula_transpose_row_literal_spills_as_column() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "TRANSPOSE({1, 2, 3})").unwrap();
        drop(rt);
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(3, 1))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 2, 0)), Value::Number(3.0));
    }

    /// `=TRANSPOSE({1; 2; 3})` at A1 spills 1×3 horizontally.
    #[test]
    fn set_formula_transpose_column_literal_spills_as_row() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "TRANSPOSE({1; 2; 3})").unwrap();
        drop(rt);
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
    }

    /// `=TRANSPOSE({1, 2; 3, 4})` swaps a 2×2 matrix's off-diagonal.
    #[test]
    fn set_formula_transpose_2x2() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "TRANSPOSE({1, 2; 3, 4})").unwrap();
        drop(rt);
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(2, 2))
        );
        // Row 0: 1, 3 (cols of original became rows).
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(3.0));
        // Row 1: 2, 4.
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(2.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 1)), Value::Number(4.0));
    }

    /// TRANSPOSE composed with SEQUENCE: `=TRANSPOSE(SEQUENCE(3))` —
    /// outer is TRANSPOSE, inner is SEQUENCE. Args evaluate via
    /// `eval_scalar_with_cache` which for an Array-returning Unified
    /// function in scalar context returns #CALC!. So TRANSPOSE
    /// receives FunctionArg::Scalar(#CALC!) and propagates the error.
    /// Pins design § 6.3 (no nested array composition in v1).
    #[test]
    fn set_formula_transpose_of_sequence_in_arg_position_is_calc_error() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 0, "TRANSPOSE(SEQUENCE(3))").unwrap();
        drop(rt);
        // Nested array composition currently surfaces as #CALC! at the
        // inner function's return. Excel canon DOES support nesting;
        // this is a v1 limitation (design § 6.3 implicit-intersection
        // deferral).
        assert_eq!(v, Value::Error(ErrorValue::Calc));
    }

    /// **W5-108 (Phase 4.7.O) — Sonnet L1 / Codex L1 closure**:
    /// FILTER composed with SEQUENCE — outer FILTER, inner SEQUENCE.
    /// Same v1 limitation as TRANSPOSE(SEQUENCE(...)): the inner
    /// Array-returning function in scalar context collapses to #CALC!.
    /// Pins design § 6.3 uniformly across the three array-returning
    /// functions.
    #[test]
    fn set_formula_filter_of_sequence_in_arg_position_is_calc_error() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt
            .set_formula(0, 0, 0, "FILTER(SEQUENCE(3), {TRUE; FALSE; TRUE})")
            .unwrap();
        drop(rt);
        assert_eq!(v, Value::Error(ErrorValue::Calc));
        assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
    }

    /// **W5-108 (Phase 4.7.O) — Sonnet L1 / Codex L1 closure**:
    /// SEQUENCE composed with SEQUENCE — outer SEQUENCE expects a
    /// scalar `rows` arg; the inner SEQUENCE in scalar context
    /// returns #CALC!. Coerces to the outer's #VALUE! path via the
    /// number-coercion fallback (or propagates the error). Either way
    /// the result is a scalar error, NOT a spill.
    #[test]
    fn set_formula_sequence_of_sequence_in_arg_position_is_error() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 0, "SEQUENCE(SEQUENCE(2))").unwrap();
        drop(rt);
        // Expect a scalar error (either #CALC! propagated from inner,
        // or #VALUE! / #NUM! from the outer's coercion of an error
        // value). Critical invariant: NO spill anchor at the cell.
        assert!(
            matches!(v, Value::Error(_)),
            "expected scalar Error, got {v:?}"
        );
        assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
    }

    // ===== W5-107 (Phase 4.7.N.2) — FILTER end-to-end =====

    /// `=FILTER({1,2,3,4}, {TRUE,FALSE,TRUE,FALSE})` spills 1×2 with
    /// kept values 1 and 3.
    #[test]
    fn set_formula_filter_row_keeps_truthy() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "FILTER({1, 2, 3, 4}, {TRUE, FALSE, TRUE, FALSE})")
            .unwrap();
        drop(rt);
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 2))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(3.0));
    }

    /// `=FILTER({1;2;3;4}, {TRUE;FALSE;TRUE;FALSE})` spills 2×1
    /// preserving column orientation.
    #[test]
    fn set_formula_filter_column_keeps_truthy() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "FILTER({1; 2; 3; 4}, {TRUE; FALSE; TRUE; FALSE})")
            .unwrap();
        drop(rt);
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(2, 1))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(3.0));
    }

    /// `=FILTER({1,2,3}, {FALSE,FALSE,FALSE})` with no if_empty →
    /// degenerate result → #CALC! at anchor, no spill.
    #[test]
    fn set_formula_filter_all_false_no_if_empty_produces_calc() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt
            .set_formula(0, 0, 0, "FILTER({1, 2, 3}, {FALSE, FALSE, FALSE})")
            .unwrap();
        drop(rt);
        assert_eq!(v, Value::Error(ErrorValue::Calc));
        assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
    }

    /// `=FILTER({1,2,3}, {FALSE,FALSE,FALSE}, "none")` with if_empty
    /// → singleton spill of "none".
    #[test]
    fn set_formula_filter_all_false_with_if_empty_spills_singleton() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(
            0,
            0,
            0,
            "FILTER({1, 2, 3}, {FALSE, FALSE, FALSE}, \"none\")",
        )
        .unwrap();
        drop(rt);
        assert_eq!(
            wb.spill_anchor_at(0, 0, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 1))
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Text(std::sync::Arc::from("none"))
        );
    }

    // ===== W5-107-AUDIT (Phase 4.7.N) — Codex HIGH + Sonnet MEDIUM/LOW closure =====

    /// Codex HIGH closure: `=TRANSPOSE(MyRange)` with `MyRange` a named
    /// range must bind cleanly — `is_aggregate_function` claims TRANSPOSE
    /// so the binder routes the named-range arg through Range context.
    /// Before the audit fix, this surfaced `NamedRangeInScalarContext`.
    #[test]
    fn set_formula_transpose_with_named_range_arg_binds_and_spills() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.set_name("MyRow", NamedTarget::Range(Range::new(0, 0, 0, 0, 2)))
            .unwrap();
        wb.put(ql_types::Address::new(0, 0, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 0, 1), Value::Number(20.0));
        wb.put(ql_types::Address::new(0, 0, 2), Value::Number(30.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 5, 0, "TRANSPOSE(MyRow)").unwrap();
        drop(rt);
        // 1×3 row → 3×1 column at (5, 0).
        assert_eq!(
            wb.spill_anchor_at(0, 5, 0).copied(),
            Some(ql_storage::SpillShape::new(3, 1))
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 5, 0)),
            Value::Number(10.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 6, 0)),
            Value::Number(20.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 7, 0)),
            Value::Number(30.0)
        );
    }

    /// Codex HIGH closure: `=FILTER(Data, Mask)` with both args as named
    /// ranges must bind. The binder previously rejected this with
    /// `NamedRangeInScalarContext`.
    #[test]
    fn set_formula_filter_with_named_range_args_binds_and_spills() {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.set_name("Data", NamedTarget::Range(Range::new(0, 0, 0, 0, 3)))
            .unwrap();
        wb.set_name("Mask", NamedTarget::Range(Range::new(0, 1, 0, 1, 3)))
            .unwrap();
        // Data row: 10, 20, 30, 40.
        wb.put(ql_types::Address::new(0, 0, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 0, 1), Value::Number(20.0));
        wb.put(ql_types::Address::new(0, 0, 2), Value::Number(30.0));
        wb.put(ql_types::Address::new(0, 0, 3), Value::Number(40.0));
        // Mask row: TRUE, FALSE, TRUE, FALSE.
        wb.put(ql_types::Address::new(0, 1, 0), Value::Boolean(true));
        wb.put(ql_types::Address::new(0, 1, 1), Value::Boolean(false));
        wb.put(ql_types::Address::new(0, 1, 2), Value::Boolean(true));
        wb.put(ql_types::Address::new(0, 1, 3), Value::Boolean(false));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 5, 0, "FILTER(Data, Mask)").unwrap();
        drop(rt);
        // Kept: 10, 30 → 1×2 row at (5, 0).
        assert_eq!(
            wb.spill_anchor_at(0, 5, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 2))
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 5, 0)),
            Value::Number(10.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 5, 1)),
            Value::Number(30.0)
        );
    }

    /// Sonnet LOW closure: TRANSPOSE referencing live cells via a named
    /// range must update through recompute_dirty when the source cells
    /// change. Pins that the producer-alias rewrite + spill-footprint
    /// hooks work for TRANSPOSE the same as they do for SEQUENCE.
    #[test]
    fn recompute_dirty_transpose_with_named_range_updates_on_value_change() {
        use crate::CalcgraphSession;
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        // Name MUST NOT be a 1–3-letter ASCII alpha sequence (e.g. `Src`,
        // `AAA`) — those lex as a `BareColumn` and produce `Expr::RangeRef`
        // BEFORE name resolution, shadowing the named range entirely.
        // Latent product limitation; not in scope for 4.7.N closure.
        wb.set_name("SrcRow", NamedTarget::Range(Range::new(0, 0, 0, 0, 1)))
            .unwrap();
        wb.put(ql_types::Address::new(0, 0, 0), Value::Number(1.0));
        wb.put(ql_types::Address::new(0, 0, 1), Value::Number(2.0));
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_formula(0, 5, 0, "TRANSPOSE(SrcRow)").unwrap();
        }
        assert_eq!(
            wb.spill_anchor_at(0, 5, 0).copied(),
            Some(ql_storage::SpillShape::new(2, 1))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 5, 0)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 6, 0)), Value::Number(2.0));

        // Mutate A1; recompute_dirty re-evaluates TRANSPOSE; spill at
        // (5,0)+(6,0) reflects the new value.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(99.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.is_complete(), "recompute failures: {result:?}");
        }
        assert_eq!(
            wb.spill_anchor_at(0, 5, 0).copied(),
            Some(ql_storage::SpillShape::new(2, 1))
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 5, 0)),
            Value::Number(99.0)
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 6, 0)), Value::Number(2.0));
    }

    /// Sonnet MEDIUM closure: FILTER shape transition through
    /// recompute_dirty. Pre: include mask keeps 2 of 4 → 1×2 spill.
    /// Mutate the mask so 3 of 4 are kept → 1×3 spill. Pins that:
    /// (a) the spill-footprint hooks fire on FILTER's recompute_dirty
    /// path, (b) the fixed-point loop catches the mid-pass shape
    /// transition, (c) old footprint cells are cleared.
    #[test]
    fn recompute_dirty_filter_with_named_ranges_grows_footprint() {
        use crate::CalcgraphSession;
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        wb.set_name("Data", NamedTarget::Range(Range::new(0, 0, 0, 0, 3)))
            .unwrap();
        wb.set_name("Mask", NamedTarget::Range(Range::new(0, 1, 0, 1, 3)))
            .unwrap();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            // Data: 10, 20, 30, 40.
            rt.set_value(0, 0, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 0, 1, Value::Number(20.0)).unwrap();
            rt.set_value(0, 0, 2, Value::Number(30.0)).unwrap();
            rt.set_value(0, 0, 3, Value::Number(40.0)).unwrap();
            // Mask: TRUE, FALSE, TRUE, FALSE.
            rt.set_value(0, 1, 0, Value::Boolean(true)).unwrap();
            rt.set_value(0, 1, 1, Value::Boolean(false)).unwrap();
            rt.set_value(0, 1, 2, Value::Boolean(true)).unwrap();
            rt.set_value(0, 1, 3, Value::Boolean(false)).unwrap();
            rt.set_formula(0, 5, 0, "FILTER(Data, Mask)").unwrap();
        }
        // Pre: 1×2 — kept 10, 30.
        assert_eq!(
            wb.spill_anchor_at(0, 5, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 2))
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 5, 0)),
            Value::Number(10.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 5, 1)),
            Value::Number(30.0)
        );

        // Flip mask cell (0, 1, 1) so 3 of 4 are kept (TRUE TRUE TRUE FALSE).
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 1, 1, Value::Boolean(true)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.is_complete(), "recompute failures: {result:?}");
        }

        // Post: 1×3 — kept 10, 20, 30. Footprint grew.
        assert_eq!(
            wb.spill_anchor_at(0, 5, 0).copied(),
            Some(ql_storage::SpillShape::new(1, 3)),
            "FILTER shape grew from 1x2 to 1x3"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 5, 0)),
            Value::Number(10.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 5, 1)),
            Value::Number(20.0)
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 5, 2)),
            Value::Number(30.0)
        );
    }

    // ===== W5-106 (Phase 4.7.M.2) — input-dependent shape transitions =====

    /// Shape transition through recompute_dirty: A1 = 3, B1 = SEQUENCE(A1)
    /// (spills B1..B3). Change A1 to 5; recompute_dirty re-evaluates B1
    /// → write_spill clears old 3x1 footprint, registers new 5x1, writes
    /// B1..B5. Pins that the shape transition itself works.
    #[test]
    fn recompute_dirty_sequence_grows_footprint() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(3.0)).unwrap(); // A1 = 3
            rt.set_formula(0, 0, 1, "SEQUENCE(A1)").unwrap(); // B1 = SEQUENCE(A1)
        }
        // Pre-state: B1 spills 3x1 (col 1, rows 0..3).
        assert_eq!(
            wb.spill_anchor_at(0, 0, 1).copied(),
            Some(ql_storage::SpillShape::new(3, 1))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 2, 1)), Value::Number(3.0));

        // Change A1 to 5 and recompute_dirty.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.is_complete(), "recompute failures: {result:?}");
        }
        // Post-state: B1 spills 5x1 (col 1, rows 0..5).
        assert_eq!(
            wb.spill_anchor_at(0, 0, 1).copied(),
            Some(ql_storage::SpillShape::new(5, 1)),
            "shape grew from 3x1 to 5x1"
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 4, 1)), Value::Number(5.0));
    }

    /// Shape transition shrinkage: A1 = 5, B1 = SEQUENCE(A1) (5x1).
    /// Change A1 to 2; expect B1 to spill 2x1, B3..B5 to become Blank.
    #[test]
    fn recompute_dirty_sequence_shrinks_footprint() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
            rt.set_formula(0, 0, 1, "SEQUENCE(A1)").unwrap();
        }
        assert_eq!(
            wb.spill_anchor_at(0, 0, 1).copied(),
            Some(ql_storage::SpillShape::new(5, 1))
        );
        // Change A1 to 2.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(2.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.is_complete(), "recompute failures: {result:?}");
        }
        assert_eq!(
            wb.spill_anchor_at(0, 0, 1).copied(),
            Some(ql_storage::SpillShape::new(2, 1))
        );
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(1.0));
        assert_eq!(wb.read(ql_types::Address::new(0, 1, 1)), Value::Number(2.0));
        // B3, B4, B5 cleared.
        assert_eq!(wb.read(ql_types::Address::new(0, 2, 1)), Value::Blank);
        assert_eq!(wb.read(ql_types::Address::new(0, 3, 1)), Value::Blank);
        assert_eq!(wb.read(ql_types::Address::new(0, 4, 1)), Value::Blank);
    }

    /// **Codex audit HIGH-1**: aliased readers don't re-eval when
    /// target values change but anchor value is unchanged.
    /// C1=SEQUENCE(3,1,1,A1), D1=C3. The anchor's value (start=1) is
    /// invariant across A1 changes; only C2 and C3 change.
    /// D1 is producer-aliased to C1 (4.7.I); D1 indexed at C1's
    /// address. Without the fix, recompute_dirty leaves D1 stale.
    ///
    /// Closed by: hook pass ALSO fires on_set_value at the anchor
    /// cell, so aliased readers (cell_to_formulas[anchor]) get dirtied.
    #[test]
    fn recompute_dirty_aliased_reader_sees_target_value_change_when_anchor_unchanged() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap(); // A1 = 1
                                                                // C1 = SEQUENCE(3, 1, 1, A1) → spill at C1 with step = A1.
                                                                // C1 = 1, C2 = 1+A1, C3 = 1+2*A1.
            rt.set_formula(0, 0, 2, "SEQUENCE(3, 1, 1, A1)").unwrap();
            // D1 = C3 — aliased to C1 via producer-alias rewrite.
            rt.set_formula(0, 0, 3, "C3").unwrap();
        }
        // Initial: A1=1, so C3=1+2*1=3. D1=3.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 3)), Value::Number(3.0));

        // Change A1 to 2. SEQUENCE result: C1=1 (unchanged!), C2=3, C3=5.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(2.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.is_complete(), "recompute failures: {result:?}");
        }
        // C1's anchor value is still 1.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(1.0));
        // C3's value changed.
        assert_eq!(wb.read(ql_types::Address::new(0, 2, 2)), Value::Number(5.0));
        // D1 = C3 should reflect the new C3 = 5.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Number(5.0),
            "D1 must reflect C3's new value even though C1 anchor is unchanged"
        );
    }

    /// **Codex audit HIGH-2**: after recompute-time spill dissolution,
    /// aliased readers don't get re-extracted. Subsequent user writes
    /// to the (now-free) target cells don't dirty the readers.
    ///
    /// A1=3, B1=SEQUENCE(A1) (spill B1..B3). X1=B2 (aliased to B1).
    /// A1=0 → B1=#CALC!, spill dissolved.
    /// User set_value(B2, 99). X1 should see B2=99.
    ///
    /// Closed by: recompute_dirty calls reextract_spill_footprint_readers
    /// for the (old, new) footprints, mirroring set_formula 4.7.J.4.
    #[test]
    fn recompute_dirty_dissolution_reextracts_aliased_readers() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(3.0)).unwrap();
            rt.set_formula(0, 0, 1, "SEQUENCE(A1)").unwrap();
            rt.set_formula(0, 0, 4, "B2").unwrap(); // X1 = B2, aliased to B1.
        }
        let x1 = graph.cell_node_for(0, 0, 4).unwrap();
        assert_eq!(
            graph.formula_deps(x1).unwrap().cells,
            vec![(0, 0, 1)],
            "X1 starts aliased to B1"
        );

        // Change A1 to 0 — SEQUENCE(0) → #NUM! per design § 13.1
        // (W5-108 / Phase 4.7.O Codex M2 closure). The recompute
        // surfaces a scalar error at B1, the spill dissolves, and
        // host dissolution still triggers the re-extraction we're
        // pinning here. Whether B1 ends as #NUM! or #CALC! is
        // orthogonal to this test's invariant.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(0.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.is_complete(), "recompute failures: {result:?}");
        }
        // X1's dep must be RE-EXTRACTED to literal B2 after the
        // host dissolution.
        assert_eq!(
            graph.formula_deps(x1).unwrap().cells,
            vec![(0, 1, 1)],
            "X1's dep re-extracted to literal B2 after spill dissolves"
        );

        // Canonical test: user writes B2 = 99. X1 should see it.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 1, 1, Value::Number(99.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.is_complete(), "recompute failures: {result:?}");
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 4)),
            Value::Number(99.0),
            "X1 must see B2's user write after dissolution + re-extract"
        );
    }

    /// **#136 closure**: A1 = 3, B1 = SEQUENCE(A1) (spills B1..B3),
    /// D1 = B5 (currently Blank — references a cell OUTSIDE the spill
    /// footprint). Change A1 to 5; B1 now spills B1..B5. D1 should see
    /// B5 = 5 and update.
    ///
    /// Closed by: (a) `try_recompute_with_simd_profile` now fires
    /// on_set_value for non-anchor cells in (old ∪ new) spill footprint
    /// after write_spill; (b) `recompute_dirty` wraps schedule+eval in
    /// a fixed-point loop so mid-pass dirties (D1 dirtied by B1's
    /// recompute writing B5) get picked up in a follow-up iteration.
    #[test]
    fn recompute_dirty_sequence_grows_dirties_new_target_readers() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(3.0)).unwrap();
            rt.set_formula(0, 0, 1, "SEQUENCE(A1)").unwrap();
            // D1 = B5 — currently Blank (outside the 3x1 spill).
            rt.set_formula(0, 0, 3, "B5").unwrap();
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Blank,
            "D1 = B5 evaluates to Blank initially (B5 outside footprint)"
        );

        // Grow the spill.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.is_complete(), "recompute failures: {result:?}");
        }

        // After recompute_dirty: D1 should see B5 = 5.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Number(5.0),
            "D1 must update to B5's new value after spill grows"
        );
    }

    // ===== W5-116 (Phase 4.8.G) — structured-ref eval through aggregate =====

    /// **First end-to-end test for Phase 4.8 structured refs.** Set up a
    /// table `Sales` with a `Qty` column; write `SUM(Sales[Qty])`; assert
    /// the result matches a hand-summed value. Exercises:
    /// - 4.8.A: TableMetadata + Workbook::tables_mut().insert.
    /// - 4.8.B: lexer Token::StructuredRef.
    /// - 4.8.C: parser Expr::StructuredRef + Combination/BareColumn.
    /// - 4.8.E: BindSite plumbing (cell address carried).
    /// - 4.8.F: TableLookup blanket impl + ExprPlan::StructuredRef
    ///   resolution against TableTable.
    /// - 4.8.G: eval-side StructuredRef arm in scalar.rs aggregate path.
    #[test]
    fn structured_ref_sum_qty_column_works_end_to_end() {
        use ql_storage::{TableColumn, TableMetadata};
        let mut wb = make_runtime_workbook();
        // Build Sales at A1:D5. Header row 0, no totals. 4 data rows.
        let col = |id, name: &str| TableColumn {
            id,
            name: Arc::from(name.to_ascii_lowercase().as_str()),
            display: Arc::from(name),
            totals_function: None,
        };
        let table = TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 5,
            cols: 4,
            has_header: true,
            has_totals: false,
            columns: vec![
                col(0, "Region"),
                col(1, "Product"),
                col(2, "Qty"),
                col(3, "Price"),
            ],
        };
        wb.tables_mut().insert(Arc::clone(&table.name), table);
        // Seed data: Qty column (col 2) data rows 1..4 with 10, 20, 30, 40.
        wb.put(ql_types::Address::new(0, 1, 2), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 2), Value::Number(20.0));
        wb.put(ql_types::Address::new(0, 3, 2), Value::Number(30.0));
        wb.put(ql_types::Address::new(0, 4, 2), Value::Number(40.0));

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Anchor the formula at a cell outside the table footprint.
        let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
        drop(rt);
        assert_eq!(v, Value::Number(100.0), "SUM(Sales[Qty]) = 10+20+30+40");
    }

    /// **Phase 4.8.G.2 e2e:** `[@Qty]` shorthand inside a table data
    /// cell resolves to the same-row's Qty value. Pins eval-time row
    /// narrowing via `WorkbookEnv::with_formula_cell`.
    #[test]
    fn structured_ref_at_column_narrows_to_current_row() {
        use ql_storage::{TableColumn, TableMetadata};
        let mut wb = make_runtime_workbook();
        let table = TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 4,
            cols: 2,
            has_header: true,
            has_totals: false,
            columns: vec![
                TableColumn {
                    id: 0,
                    name: Arc::from("qty"),
                    display: Arc::from("Qty"),
                    totals_function: None,
                },
                TableColumn {
                    id: 1,
                    name: Arc::from("doubled"),
                    display: Arc::from("Doubled"),
                    totals_function: None,
                },
            ],
        };
        wb.tables_mut().insert(Arc::clone(&table.name), table);
        // Header row at 0 (A1, B1). Data rows 1..3.
        // A2=10, A3=20, A4=30.
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        wb.put(ql_types::Address::new(0, 3, 0), Value::Number(30.0));

        let reg = default_registry();
        // Write `=Sales[@Qty]*2` into B2 (data row 1, col 1 → "Doubled").
        // Eval should narrow to A2 → 10 → result 20.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 1, 1, "Sales[@Qty]*2").unwrap();
        assert_eq!(v, Value::Number(20.0), "[@Qty] at B2 narrows to A2=10");
        // Same formula at B3 narrows to A3=20 → result 40.
        let v3 = rt.set_formula(0, 2, 1, "Sales[@Qty]*2").unwrap();
        assert_eq!(v3, Value::Number(40.0), "[@Qty] at B3 narrows to A3=20");
        // Same formula at B4 narrows to A4=30 → result 60.
        let v4 = rt.set_formula(0, 3, 1, "Sales[@Qty]*2").unwrap();
        assert_eq!(v4, Value::Number(60.0), "[@Qty] at B4 narrows to A4=30");
    }

    /// **Phase 4.8.G.2 e2e:** `[@Qty]` typed OUTSIDE the table's data
    /// rows → `#VALUE!` per Excel canon. Validates the
    /// `narrow_structured_ref` out-of-range guard.
    #[test]
    fn structured_ref_at_column_outside_table_returns_value_error() {
        use ql_storage::{TableColumn, TableMetadata};
        let mut wb = make_runtime_workbook();
        let table = TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            columns: vec![TableColumn {
                id: 0,
                name: Arc::from("qty"),
                display: Arc::from("Qty"),
                totals_function: None,
            }],
        };
        wb.tables_mut().insert(Arc::clone(&table.name), table);
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Formula at row 5 — well outside the table (which is rows 0-1).
        let v = rt.set_formula(0, 5, 5, "Sales[@Qty]").unwrap();
        assert_eq!(
            v,
            Value::Error(ErrorValue::Value),
            "[@Qty] outside table data rows returns #VALUE!"
        );
    }

    // ===== W5-118 (Phase 4.8.H) — create_table / drop_table + op log =====

    #[test]
    fn create_table_happy_path_registers_and_emits_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                5,
                3,
                true,
                false,
                vec!["Region".into(), "Qty".into(), "Price".into()],
            )
            .unwrap();
        }
        let t = wb.lookup_table("Sales").expect("registered");
        assert_eq!(t.name.as_ref(), "SALES");
        assert_eq!(t.display_name.as_ref(), "Sales");
        assert_eq!(t.cols, 3);
        assert_eq!(t.rows, 5);
        assert!(t.has_header);
        assert!(!t.has_totals);
        // Verify op-log emission.
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        assert!(matches!(&ops[0], Op::CreateTable { name, .. } if name == "SALES"));
    }

    // ===== W5-124 (Phase 4.8.J.2) — spill-anchor uniform check =====

    #[test]
    fn create_table_rejected_when_footprint_contains_spill_anchor() {
        use ql_storage::SpillShape;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Register a spill anchor at (0, 2, 1) covering 3 rows x 1 col.
        wb.register_spill((0, 2, 1), SpillShape::new(3, 1))
            .expect("register_spill must succeed on empty workbook");
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Try to create a table whose footprint covers the anchor.
        let err = rt
            .create_table(
                "T",
                0,
                0,
                0,
                5,
                3,
                true,
                false,
                vec!["a".into(), "b".into(), "c".into()],
            )
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("spill anchor"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_succeeds_when_anchor_is_outside_footprint() {
        use ql_storage::SpillShape;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Anchor at column 10 — outside the table footprint at cols 0-2.
        wb.register_spill((0, 0, 10), SpillShape::new(2, 1))
            .expect("register_spill must succeed");
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table(
            "T",
            0,
            0,
            0,
            3,
            3,
            true,
            false,
            vec!["a".into(), "b".into(), "c".into()],
        )
        .expect("non-overlapping anchor must not block create_table");
        assert!(wb.lookup_table("T").is_some());
    }

    #[test]
    fn resize_table_grow_rejected_when_new_cells_contain_spill_anchor() {
        use ql_storage::SpillShape;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // Initial table covers rows 0-2, col 0.
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Spill anchor BELOW the table at row 5.
        wb.register_spill((0, 5, 0), SpillShape::new(2, 1))
            .expect("register_spill must succeed");
        // Grow the table to row 10 — would now cover the anchor at row 5.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.resize_table("Sales", 10, 1, vec![], vec![]).unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("spill anchor"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_grow_succeeds_when_anchor_is_outside_new_footprint() {
        use ql_storage::SpillShape;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Anchor at row 20 — outside the resized footprint (max row 4).
        wb.register_spill((0, 20, 0), SpillShape::new(2, 1))
            .expect("register_spill must succeed");
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.resize_table("Sales", 5, 1, vec![], vec![])
            .expect("anchor outside new footprint must not block");
        let meta = wb.lookup_table("Sales").unwrap();
        assert_eq!(meta.rows, 5);
    }

    // ===== W5-125 (Phase 4.8.O.1) — footprint-bounds upper-limit check =====

    #[test]
    fn create_table_rejects_footprint_past_max_row() {
        use ql_types::MAX_ROW;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // top_row = MAX_ROW - 1, rows = 3 → last row = MAX_ROW + 1 > MAX_ROW.
        let err = rt
            .create_table(
                "Far",
                0,
                MAX_ROW - 1,
                0,
                3,
                1,
                true,
                false,
                vec!["Qty".into()],
            )
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("MAX_ROW"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_rejects_footprint_past_max_column() {
        use ql_types::MAX_COLUMN;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // top_col = MAX_COLUMN, cols = 2 → last col = MAX_COLUMN + 1 > MAX_COLUMN.
        let err = rt
            .create_table(
                "Wide",
                0,
                0,
                MAX_COLUMN,
                1,
                2,
                true,
                false,
                vec!["A".into(), "B".into()],
            )
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("MAX_COLUMN"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_rejects_footprint_u32_overflow_on_rows() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // top_row = u32::MAX, rows = 2 → top_row + rows wraps. Pre-W5-125 the
        // footprint loop `for r in u32::MAX..u32::MAX+2 (wrapped to 1)` was
        // empty and downstream overlap / spill-anchor checks silently skipped.
        let err = rt
            .create_table("Wrap", 0, u32::MAX, 0, 2, 1, true, false, vec!["X".into()])
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(
                    reason.contains("u32 overflow") || reason.contains("addressable"),
                    "reason: {reason}"
                );
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_rejects_growing_past_max_row() {
        use ql_types::MAX_ROW;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // Create a table near (but inside) MAX_ROW.
            rt.create_table(
                "Sales",
                0,
                MAX_ROW - 4,
                0,
                3,
                1,
                true,
                false,
                vec!["Qty".into()],
            )
            .unwrap();
        }
        // Grow to 10 rows → last_row = MAX_ROW - 4 + 9 = MAX_ROW + 5 > MAX_ROW.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.resize_table("Sales", 10, 1, vec![], vec![]).unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("MAX_ROW"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_rejects_overlap() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table(
            "A",
            0,
            0,
            0,
            5,
            2,
            true,
            false,
            vec!["x".into(), "y".into()],
        )
        .unwrap();
        // Overlapping footprint should reject.
        let err = rt
            .create_table(
                "B",
                0,
                2,
                1,
                3,
                2,
                true,
                false,
                vec!["p".into(), "q".into()],
            )
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("overlap"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_rejects_duplicate_column_names_case_insensitive() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .create_table(
                "T",
                0,
                0,
                0,
                2,
                2,
                true,
                false,
                vec!["Qty".into(), "qty".into()],
            )
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("unique"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_rejects_namespace_collision_with_defined_name() {
        let mut wb = make_runtime_workbook();
        wb.set_name("FOO", ql_storage::NamedTarget::Constant(Value::Number(1.0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .create_table("Foo", 0, 0, 0, 2, 1, true, false, vec!["x".into()])
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("defined-name"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn drop_table_removes_metadata_and_emits_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.drop_table("Sales").unwrap();
        }
        assert!(wb.lookup_table("Sales").is_none());
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 2);
        assert!(matches!(&ops[1], Op::DropTable { name } if name == "SALES"));
    }

    #[test]
    fn drop_table_missing_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.drop_table("Nope").unwrap_err();
        match err {
            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
            other => panic!("expected TableNotFound, got {other:?}"),
        }
    }

    /// **W5-155 / W5-156 (Phase 4.8.G.3):** `WorkbookRuntime::drop_table`
    /// must (a) invoke the calcgraph `on_table_drop` hook so any
    /// formula referencing the dropped table is BFS-dirtied, (b)
    /// invalidate the plan cache so the next bind doesn't HIT a stale
    /// `ExprPlan::StructuredRef`, and (c) write `#NAME?` to those
    /// cells on the next `recompute_dirty`. W5-155 shipped (a) but not
    /// (b) or (c), leaving the hook functionally inert (the cache hit
    /// served the pre-drop range and eval read the same data cells).
    /// W5-156 closes HIGH-1 (cache flush in `drop_table`) + HIGH-2
    /// (bind-error → cell-value mapping at recompute_dirty:3266).
    #[test]
    fn drop_table_fires_on_table_drop_hook_and_emits_name_error() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        // Build: Sales table at A1:A3 (header + 2 data rows) with
        // column Qty, values 10/20, and B1 = SUM(Sales[Qty]).
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
            let v = rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
            // Drain dirty so the post-drop assertion is unambiguous.
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        let formula_node = graph
            .cell_node_for(0, 0, 1)
            .expect("B1 formula node registered");
        assert!(
            !graph.is_dirty(formula_node),
            "after recompute_dirty B1 should be clean"
        );
        let before = graph.hook_counts().table_drop;

        // Drop the table — the hook must fire and dirty B1.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.drop_table("Sales").unwrap();
        }
        assert_eq!(
            graph.hook_counts().table_drop,
            before + 1,
            "drop_table must call on_table_drop exactly once"
        );
        assert!(
            graph.is_dirty(formula_node),
            "B1 = SUM(Sales[Qty]) must be dirty after Sales is dropped"
        );

        // **W5-156 HIGH-2 closure:** recompute must produce `#NAME?`
        // at B1, not preserve the pre-drop `Number(30.0)`. Tests both
        // the cache-flush (HIGH-1) and the bind-error → cell-value
        // mapping (HIGH-2) end-to-end.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(
                result.failures.is_empty(),
                "table-related bind errors should map to #NAME? cells, \
                 not RecomputeFailure entries — got: {:?}",
                result.failures
            );
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::Name),
            "B1 = SUM(Sales[Qty]) must produce #NAME? after Sales is dropped"
        );
    }

    /// **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):** transitive BFS
    /// fanout. C1 = B1 + 1 depends on B1 = SUM(Sales[Qty]). Dropping
    /// Sales must dirty BOTH B1 (direct reader) AND C1 (transitive via
    /// the W5-91 H2 BFS pattern from `mark_dirty_from_cell_write`);
    /// recompute then propagates #NAME? through the chain.
    #[test]
    fn drop_table_propagates_name_error_through_chain() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
            rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap(); // B1 = 30
            rt.set_formula(0, 0, 2, "B1 + 1").unwrap(); // C1 = 31
            assert_eq!(
                wb.read(ql_types::Address::new(0, 0, 2)),
                Value::Number(31.0)
            );
        }
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.drop_table("Sales").unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.failures.is_empty(), "no structural failures");
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::Name),
            "B1: direct reader of dropped table → #NAME?"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 2)),
            Value::Error(ErrorValue::Name),
            "C1 = B1 + 1: transitive #NAME? propagation"
        );
    }

    // ===== W5-119 (Phase 4.8.I) — rename_table =====

    #[test]
    fn rename_table_happy_path_rewrites_formula_text() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        // Formula referencing the table.
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
        }
        // Rename Sales → Orders.
        let rewritten = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.rename_table("Sales", "Orders").unwrap()
        };
        assert_eq!(rewritten, 1, "one formula was rewritten");
        // Verify table table re-keyed.
        assert!(wb.lookup_table("Sales").is_none());
        assert!(wb.lookup_table("Orders").is_some());
        // Verify formula text rewritten.
        let text = wb.formula_at(0, 10, 0).expect("formula present").clone();
        assert!(
            text.contains("Orders"),
            "formula text should now reference Orders, got: {text}"
        );
        assert!(
            !text.contains("Sales"),
            "formula text should NOT reference Sales after rename, got: {text}"
        );
        // Re-bind + re-eval after rename — value still 30.
        let v = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            assert!(rt.recompute_all().is_complete());
            wb.read(ql_types::Address::new(0, 10, 0))
        };
        assert_eq!(v, Value::Number(30.0));
    }

    #[test]
    fn rename_table_target_collision_with_table_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("A", 0, 0, 0, 2, 1, true, false, vec!["x".into()])
            .unwrap();
        rt.create_table("B", 0, 0, 5, 2, 1, true, false, vec!["y".into()])
            .unwrap();
        let err = rt.rename_table("A", "B").unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("rename target"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn rename_table_missing_source_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.rename_table("Nope", "Yep").unwrap_err();
        match err {
            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
            other => panic!("expected TableNotFound, got {other:?}"),
        }
    }

    #[test]
    fn rename_table_emits_ops() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table("S", 0, 0, 0, 2, 1, true, false, vec!["Q".into()])
                .unwrap();
            rt.set_formula(0, 5, 0, "SUM(S[Q])").unwrap();
            let _ = rt.rename_table("S", "T").unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // CreateTable + PutFormula + RenameTable + PutFormula (rewrite).
        assert_eq!(ops.len(), 4, "got {ops:?}");
        assert!(matches!(&ops[2], Op::RenameTable { old_name, new_name }
            if old_name == "S" && new_name == "T"));
        match &ops[3] {
            Op::PutFormula { text, .. } => {
                assert!(text.contains('T'));
            }
            other => panic!("expected PutFormula for rewrite, got {other:?}"),
        }
    }

    /// **W5-157 (Phase 4.8.G.3):** `rename_table` fires
    /// `on_table_rename` so the calcgraph reverse index re-keys
    /// from OLD → NEW. A subsequent `drop_table(NEW)` must then
    /// produce `#NAME?` at the reader. Without the hook, the
    /// index stays under OLD and `drop_table(NEW)` would miss
    /// every previously-bound formula.
    #[test]
    fn rename_table_then_drop_new_name_emits_name_error() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
            let v = rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        let before_rename_count = graph.hook_counts().table_rename;

        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let rewritten = rt.rename_table("Sales", "Orders").unwrap();
            assert_eq!(rewritten, 1, "B1's formula text was rewritten");
            // Drain the rename's dirty fanout — B1 re-binds against Orders
            // and produces the same Number(30.0) (same cells, same data).
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        assert_eq!(
            graph.hook_counts().table_rename,
            before_rename_count + 1,
            "rename_table must fire on_table_rename exactly once"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(30.0),
            "post-rename: same cells, same value"
        );

        // Now drop under the NEW name — the index must find B1.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.drop_table("Orders").unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(
                result.failures.is_empty(),
                "no structural failures: {:?}",
                result.failures
            );
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::Name),
            "rename(Sales→Orders) then drop(Orders): B1 must be #NAME? — \
             proves on_table_rename re-keyed the calcgraph index"
        );
    }

    // ===== W5-121 (Phase 4.8.I.2) — rename_column =====

    #[test]
    fn rename_column_happy_path_rewrites_formula_text() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
        }
        let rewritten = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
        };
        assert_eq!(rewritten, 1, "one formula was rewritten");
        // TableMetadata reflects rename.
        let meta = wb.lookup_table("Sales").expect("table present");
        let (idx, col) = meta.lookup_column("Quantity").expect("new column present");
        assert_eq!(idx, 0);
        assert_eq!(col.name.as_ref(), "quantity");
        assert_eq!(col.display.as_ref(), "Quantity");
        assert!(
            meta.lookup_column("Qty").is_none(),
            "old column gone from metadata"
        );
        // Formula text rewritten.
        let text = wb.formula_at(0, 10, 0).expect("formula present").clone();
        assert!(
            text.contains("Quantity"),
            "formula text should reference Quantity, got: {text}"
        );
        assert!(
            !text.contains("Qty"),
            "formula text should NOT reference Qty after rename, got: {text}"
        );
        // Recompute confirms re-bind against the new column name.
        let v = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            assert!(rt.recompute_all().is_complete());
            wb.read(ql_types::Address::new(0, 10, 0))
        };
        assert_eq!(v, Value::Number(30.0));
    }

    #[test]
    fn rename_column_combination_form_rewritten() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                3,
                2,
                true,
                false,
                vec!["Qty".into(), "Price".into()],
            )
            .unwrap();
        }
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // Multi-item combination: select #Data rows of Qty.
            let v = rt
                .set_formula(0, 10, 0, "SUM(Sales[[#Data], [Qty]])")
                .unwrap();
            assert_eq!(v, Value::Number(30.0));
        }
        let rewritten = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
        };
        assert_eq!(rewritten, 1);
        let text = wb.formula_at(0, 10, 0).expect("formula").clone();
        assert!(text.contains("Quantity"), "got: {text}");
        assert!(!text.contains("Qty"), "got: {text}");
        // Other column untouched.
        let meta = wb.lookup_table("Sales").unwrap();
        assert!(meta.lookup_column("Price").is_some());
    }

    #[test]
    fn rename_column_this_row_form_rewritten() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                3,
                2,
                true,
                false,
                vec!["Qty".into(), "Doubled".into()],
            )
            .unwrap();
        }
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        // `=Sales[@Qty]*2` at B2 (data row 0).
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let v = rt.set_formula(0, 1, 1, "Sales[@Qty]*2").unwrap();
            assert_eq!(v, Value::Number(20.0));
        }
        let rewritten = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
        };
        assert_eq!(rewritten, 1);
        let text = wb.formula_at(0, 1, 1).expect("formula").clone();
        assert!(text.contains("Quantity"), "got: {text}");
        assert!(!text.contains("Qty"), "got: {text}");
        // Re-eval still produces 20.
        let v = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            assert!(rt.recompute_all().is_complete());
            wb.read(ql_types::Address::new(0, 1, 1))
        };
        assert_eq!(v, Value::Number(20.0));
    }

    #[test]
    fn rename_column_other_table_unaffected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // Two tables with the same column name.
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.create_table("Orders", 0, 0, 5, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        wb.put(ql_types::Address::new(0, 6, 0), Value::Number(100.0));
        wb.put(ql_types::Address::new(0, 7, 0), Value::Number(200.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            rt.set_formula(0, 11, 0, "SUM(Orders[Qty])").unwrap();
        }
        let rewritten = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
        };
        assert_eq!(rewritten, 1, "only the Sales formula was rewritten");
        // Sales formula updated.
        let sales_text = wb.formula_at(0, 10, 0).expect("formula").clone();
        assert!(sales_text.contains("Quantity"), "got: {sales_text}");
        // Orders formula untouched.
        let orders_text = wb.formula_at(0, 11, 0).expect("formula").clone();
        assert!(orders_text.contains("Qty"), "got: {orders_text}");
        assert!(!orders_text.contains("Quantity"), "got: {orders_text}");
        // Orders column metadata untouched too.
        let orders = wb.lookup_table("Orders").unwrap();
        assert!(orders.lookup_column("Qty").is_some());
        assert!(orders.lookup_column("Quantity").is_none());
    }

    #[test]
    fn rename_column_target_collision_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table(
            "Sales",
            0,
            0,
            0,
            2,
            2,
            true,
            false,
            vec!["Qty".into(), "Price".into()],
        )
        .unwrap();
        let err = rt.rename_column("Sales", "Qty", "Price").unwrap_err();
        match err {
            RuntimeError::TableColumnRejected { reason, .. } => {
                assert!(reason.contains("rename target"), "reason: {reason}");
            }
            other => panic!("expected TableColumnRejected, got {other:?}"),
        }
    }

    #[test]
    fn rename_column_missing_source_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
            .unwrap();
        let err = rt.rename_column("Sales", "Nope", "Whatever").unwrap_err();
        match err {
            RuntimeError::TableColumnNotFound { table, column } => {
                assert_eq!(table, "Sales");
                assert_eq!(column, "Nope");
            }
            other => panic!("expected TableColumnNotFound, got {other:?}"),
        }
    }

    #[test]
    fn rename_column_unknown_table_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.rename_column("Nope", "A", "B").unwrap_err();
        match err {
            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
            other => panic!("expected TableNotFound, got {other:?}"),
        }
    }

    #[test]
    fn rename_column_empty_target_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
            .unwrap();
        let err = rt.rename_column("Sales", "Qty", "").unwrap_err();
        match err {
            RuntimeError::TableColumnRejected { reason, .. } => {
                assert!(reason.contains("cannot be empty"), "reason: {reason}");
            }
            other => panic!("expected TableColumnRejected, got {other:?}"),
        }
    }

    #[test]
    fn rename_column_same_canonical_is_noop() {
        // Display-only case rename (e.g. "Qty" → "QTY") shares the
        // lowercase canonical, so the runtime accepts silently with
        // Ok(0) and emits no op. Mirrors `rename_table` policy.
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
                .unwrap();
            let n = rt.rename_column("Sales", "Qty", "QTY").unwrap();
            assert_eq!(n, 0);
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // Only the CreateTable op landed; no RenameColumn op emitted.
        assert_eq!(ops.len(), 1, "got {ops:?}");
        assert!(matches!(&ops[0], Op::CreateTable { .. }));
    }

    #[test]
    fn rename_column_emits_ops() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table("S", 0, 0, 0, 2, 1, true, false, vec!["Q".into()])
                .unwrap();
            rt.set_formula(0, 5, 0, "SUM(S[Q])").unwrap();
            let n = rt.rename_column("S", "Q", "R").unwrap();
            assert_eq!(n, 1);
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // CreateTable + PutFormula + RenameColumn + PutFormula (rewrite).
        assert_eq!(ops.len(), 4, "got {ops:?}");
        assert!(
            matches!(&ops[2], Op::RenameColumn { table, old_name, new_name }
            if table == "S" && old_name == "Q" && new_name == "R")
        );
        match &ops[3] {
            Op::PutFormula { text, .. } => {
                assert!(text.contains('R'), "text: {text}");
                assert!(!text.contains('Q'), "text: {text}");
            }
            other => panic!("expected PutFormula for rewrite, got {other:?}"),
        }
    }

    /// **W5-158 (Phase 4.8.G.3):** `rename_column` fires the
    /// `on_column_rename` hook → readers are in the dirty set →
    /// `recompute_dirty` re-binds them against the new column
    /// name. The cell value is unchanged (same column index, same
    /// data range; VEQ suppresses the write) but the hook
    /// observability + dirty/clean state are correct.
    #[test]
    fn rename_column_fires_hook_and_keeps_value_consistent() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
            let v = rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        let before = graph.hook_counts().column_rename;
        let formula_node = graph
            .cell_node_for(0, 0, 1)
            .expect("B1 formula node registered");
        assert!(!graph.is_dirty(formula_node), "clean baseline");

        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let rewritten = rt.rename_column("Sales", "Qty", "Quantity").unwrap();
            assert_eq!(rewritten, 1);
        }
        assert_eq!(
            graph.hook_counts().column_rename,
            before + 1,
            "hook fired exactly once"
        );
        assert!(
            graph.is_dirty(formula_node),
            "post-rename: B1 must be in the dirty set so recompute re-binds"
        );

        // Recompute drains the dirty set; value stays at 30 (VEQ suppresses).
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.failures.is_empty());
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(30.0),
            "post-rename value unchanged (same column index, same data)"
        );
        assert!(
            !graph.is_dirty(formula_node),
            "recompute drained the dirty set"
        );
    }

    // ===== W5-122 (Phase 4.8.J) — resize_table =====

    #[test]
    fn resize_table_grow_rows_extends_sum_range() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Initial: header at row 0, data at rows 1-2 = 10, 20 → SUM = 30.
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
        }
        // Add data BELOW current footprint, then resize to include it.
        wb.put(ql_types::Address::new(0, 3, 0), Value::Number(40.0));
        wb.put(ql_types::Address::new(0, 4, 0), Value::Number(50.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.resize_table("Sales", 5, 1, vec![], vec![]).unwrap();
            assert!(rt.recompute_all().is_complete());
        }
        // SUM now covers rows 1..4 = 10+20+40+50 = 120.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 10, 0)),
            Value::Number(120.0)
        );
        // Metadata reflects new dims.
        let meta = wb.lookup_table("Sales").unwrap();
        assert_eq!(meta.rows, 5);
        assert_eq!(meta.cols, 1);
    }

    /// **W5-159 (Phase 4.8.G.3):** the correctness bug the hook +
    /// re-extract closes. After `resize_table` grows the data range,
    /// a cell write into the NEW row (outside the OLD range) must
    /// dirty the formula via the calcgraph's range stripe and
    /// `recompute_dirty` must pick it up. Pre-W5-159 the stripe
    /// stayed registered at the OLD range; the write silently missed;
    /// the formula kept its post-resize-but-pre-write value
    /// indefinitely (until something else dirtied it). The
    /// `recompute_all` path in the existing W5-122 test happened to
    /// work because full passes don't rely on stripes — so this gap
    /// only surfaces on the incremental path.
    #[test]
    fn resize_table_grow_then_recompute_dirty_picks_up_new_range_writes() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        // Initial: header at row 0, data at rows 1-2 = 10, 20 → SUM = 30.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        // Grow the table from 3 rows (header + 2 data) to 5 rows
        // (header + 4 data). recompute_dirty after the resize.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.resize_table("Sales", 5, 1, vec![], vec![]).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.failures.is_empty(), "no structural failures");
        }
        // Existing cells in rows 3-4 are blank → SUM unchanged at 30.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 10, 0)),
            Value::Number(30.0),
            "post-resize: rows 3-4 are blank → SUM stays 30"
        );

        // **THE CRITICAL ASSERTION:** write a NEW value into row 3
        // (inside the new range, outside the old range). The formula's
        // stripe MUST cover this cell after W5-159's re-extract.
        // recompute_dirty MUST pick up the change.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 3, 0, Value::Number(40.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.failures.is_empty());
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 10, 0)),
            Value::Number(70.0),
            "post-resize write at row 3: SUM = 10+20+40 = 70. \
             Pre-W5-159 this stayed at 30 because the stripe was stale."
        );

        // Same for row 4.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 4, 0, Value::Number(50.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.failures.is_empty());
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 10, 0)),
            Value::Number(120.0),
            "row 4 write: SUM = 10+20+40+50 = 120"
        );
    }

    #[test]
    fn resize_table_shrink_rows_truncates_sum_range() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 5, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Header at row 0, data at rows 1-4 = 10, 20, 40, 50.
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        wb.put(ql_types::Address::new(0, 3, 0), Value::Number(40.0));
        wb.put(ql_types::Address::new(0, 4, 0), Value::Number(50.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(120.0));
        }
        // Shrink from 5 rows to 3 (drop bottom 2 data rows).
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.resize_table("Sales", 3, 1, vec![], vec![]).unwrap();
            assert!(rt.recompute_all().is_complete());
        }
        // SUM now covers rows 1..2 = 30.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 10, 0)),
            Value::Number(30.0)
        );
        // Cells at rows 3-4 still hold their values (storage isn't
        // touched), but they're no longer part of the table.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 3, 0)),
            Value::Number(40.0)
        );
        assert!(wb.table_at(0, 3, 0).is_none(), "row 3 no longer in table");
    }

    #[test]
    fn resize_table_add_column_appends_new_column() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Resize: cols 1 → 2, add "Price".
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.resize_table("Sales", 3, 2, vec!["Price".into()], vec![])
                .unwrap();
        }
        let meta = wb.lookup_table("Sales").unwrap();
        assert_eq!(meta.cols, 2);
        assert_eq!(meta.columns.len(), 2);
        let (idx, col) = meta.lookup_column("Price").unwrap();
        assert_eq!(idx, 1);
        assert_eq!(col.name.as_ref(), "price");
        assert_eq!(col.display.as_ref(), "Price");
        // Pre-existing column intact.
        assert!(meta.lookup_column("Qty").is_some());
        // New column has a freshly allocated id distinct from Qty's.
        let qty_id = meta.lookup_column("Qty").unwrap().1.id;
        assert_ne!(col.id, qty_id);
    }

    #[test]
    fn resize_table_remove_last_column_drops_column() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                3,
                2,
                true,
                false,
                vec!["Qty".into(), "Price".into()],
            )
            .unwrap();
        }
        // Resize: drop "Price".
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.resize_table("Sales", 3, 1, vec![], vec!["Price".into()])
                .unwrap();
        }
        let meta = wb.lookup_table("Sales").unwrap();
        assert_eq!(meta.cols, 1);
        assert_eq!(meta.columns.len(), 1);
        assert!(meta.lookup_column("Qty").is_some());
        assert!(meta.lookup_column("Price").is_none());
    }

    /// **W5-159 / W5-156 (Phase 4.8.G.3 — Codex closing-megaudit LOW
    /// closure):** resize removing a column that a formula references
    /// must (a) reach the formula via `reextract_table_readers`
    /// (re-bind fails with UnknownTableColumn → mark_dirty), and
    /// (b) be mapped to `#NAME?` by recompute_dirty's W5-156 failure
    /// arm. End-to-end this proves the W5-156 + W5-159 mapping covers
    /// `UnknownTableColumn` in addition to `UnknownTable`.
    #[test]
    fn resize_table_remove_referenced_column_emits_name_error() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                3,
                2,
                true,
                false,
                vec!["Qty".into(), "Price".into()],
            )
            .unwrap();
            rt.set_value(0, 1, 1, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 1, Value::Number(20.0)).unwrap();
            let v = rt.set_formula(0, 0, 3, "SUM(Sales[Price])").unwrap();
            assert_eq!(v, Value::Number(30.0));
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        // Drop the Price column.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.resize_table("Sales", 3, 1, vec![], vec!["Price".into()])
                .unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(
                result.failures.is_empty(),
                "UnknownTableColumn must map to #NAME?, not RecomputeFailure — got: {:?}",
                result.failures
            );
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Error(ErrorValue::Name),
            "SUM(Sales[Price]) → #NAME? after Price is removed by resize"
        );
    }

    #[test]
    fn resize_table_unknown_table_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.resize_table("Nope", 5, 1, vec![], vec![]).unwrap_err();
        match err {
            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
            other => panic!("expected TableNotFound, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_zero_dims_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        let err = rt.resize_table("Sales", 0, 1, vec![], vec![]).unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("> 0"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_arithmetic_mismatch_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        // old_cols=1, add 1, remove 0 → expect new_cols = 2; pass 3 instead.
        let err = rt
            .resize_table("Sales", 3, 3, vec!["Price".into()], vec![])
            .unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("does not match"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_removed_columns_not_trailing_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table(
            "Sales",
            0,
            0,
            0,
            3,
            3,
            true,
            false,
            vec!["A".into(), "B".into(), "C".into()],
        )
        .unwrap();
        // removed_columns = ["A"] — but A is NOT trailing (trailing is C).
        let err = rt
            .resize_table("Sales", 3, 2, vec![], vec!["A".into()])
            .unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("do not match trailing"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_overlap_with_other_table_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // Sales at rows 0-2, cols 0-0.
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            // Orders at rows 5-7, cols 0-0.
            rt.create_table("Orders", 0, 5, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Grow Sales to 10 rows — would overlap Orders at rows 5-7.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.resize_table("Sales", 10, 1, vec![], vec![]).unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("overlaps"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_added_column_duplicate_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        // Adding "qty" (lowercase) collides with existing "Qty".
        let err = rt
            .resize_table("Sales", 3, 2, vec!["qty".into()], vec![])
            .unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(
                    reason.contains("duplicate canonical names"),
                    "reason: {reason}"
                );
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_removed_columns_excess_count_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        // Only 1 column exists; trying to remove 2. Use new_cols=1
        // so the zero-dims check doesn't fire first (the
        // excess-count check is what we want to pin here).
        let err = rt
            .resize_table("Sales", 3, 1, vec![], vec!["Qty".into(), "Phantom".into()])
            .unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(
                    reason.contains("exceeds existing column count"),
                    "reason: {reason}"
                );
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_emits_ops() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.resize_table("Sales", 5, 2, vec!["Price".into()], vec![])
                .unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // CreateTable + ResizeTable.
        assert_eq!(ops.len(), 2, "got {ops:?}");
        assert!(matches!(
            &ops[1],
            Op::ResizeTable {
                name,
                new_rows,
                new_cols,
                added_columns,
                removed_columns,
            } if name == "SALES"
                && *new_rows == 5
                && *new_cols == 2
                && added_columns == &vec!["Price".to_owned()]
                && removed_columns.is_empty()
        ));
    }

    /// **W5-127 (Phase 4.8.O.3 — Codex LOW-1):** exact no-op resize
    /// (same dims, no column changes) returns `Ok(())` without
    /// emitting an `Op::ResizeTable`. Mirrors `rename_column`'s
    /// same-canonical no-op contract — caller-visible behavior is
    /// unchanged but the op log stays compact.
    #[test]
    fn resize_table_exact_noop_emits_nothing() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                3,
                2,
                true,
                false,
                vec!["Qty".into(), "Price".into()],
            )
            .unwrap();
            // Exact no-op: same dims, empty added + removed.
            rt.resize_table("Sales", 3, 2, vec![], vec![])
                .expect("exact no-op must succeed silently");
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // Only the CreateTable op landed; no ResizeTable emitted.
        assert_eq!(ops.len(), 1, "got {ops:?}");
        assert!(matches!(&ops[0], Op::CreateTable { .. }));
        // Sanity: table metadata unchanged.
        let meta = wb.lookup_table("Sales").unwrap();
        assert_eq!(meta.rows, 3);
        assert_eq!(meta.cols, 2);
        assert_eq!(meta.columns.len(), 2);
    }

    /// **End-to-end with op log**: create_table emits Op::CreateTable;
    /// SUM(Sales[Qty]) using the just-created table works. Validates
    /// the runtime API end-to-end.
    #[test]
    fn create_table_then_sum_column_works() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        drop(rt);
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(7.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(13.0));
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 5, 0, "SUM(Sales[Qty])").unwrap();
        assert_eq!(v, Value::Number(20.0));
    }

    /// AVERAGE through the same path — confirms the cache fast path
    /// works for StructuredRef single-arg (not just SUM).
    #[test]
    fn structured_ref_average_qty_column_works_end_to_end() {
        use ql_storage::{TableColumn, TableMetadata};
        let mut wb = make_runtime_workbook();
        let table = TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 3,
            cols: 1,
            has_header: true,
            has_totals: false,
            columns: vec![TableColumn {
                id: 0,
                name: Arc::from("qty"),
                display: Arc::from("Qty"),
                totals_function: None,
            }],
        };
        wb.tables_mut().insert(Arc::clone(&table.name), table);
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 5, 0, "AVERAGE(Sales[Qty])").unwrap();
        drop(rt);
        assert_eq!(v, Value::Number(15.0), "AVERAGE(Sales[Qty]) = 15");
    }

    // (Tier D1 Step 3.2: W5-146 config tests moved to
    //  config.rs::tests.)

    // -------------------------------------------------------------
    // W5-147 (Phase 4.9.K) — set_formula canonical-storage tests.
    // -------------------------------------------------------------

    /// **R1C1 input canonicalizes to A1 in storage.** When the
    /// workbook is in R1C1 mode and user types `R1C1`, the stored
    /// formula text is `$A$1` (A1+EnUs canon).
    #[test]
    fn set_formula_canonicalizes_r1c1_input_to_a1() {
        let mut wb = make_runtime_workbook();
        wb.set_reference_mode(ql_types::ReferenceMode::R1C1);
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "R1C1+R2C2").unwrap();
        drop(rt);
        // Stored text uses A1 + absolute markers ($) since the source
        // R1C1Ref `Abs(1),Abs(1)` becomes A1's `$A$1`.
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("$A$1 + $B$2")
        );
    }

    /// **Relative R1C1 canonicalizes using the formula's own cell
    /// as anchor.** `R[-1]C` at cell (1, 0) → `A1` (no `$` — relative
    /// R1C1 ↔ unprefixed A1).
    #[test]
    fn set_formula_canonicalizes_relative_r1c1_to_unprefixed_a1() {
        let mut wb = make_runtime_workbook();
        wb.set_reference_mode(ql_types::ReferenceMode::R1C1);
        wb.put_at(0, 0, 0, ql_types::Value::Number(7.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // At cell (1, 0), R[-1]C means "row above, same column" = A1.
        rt.set_formula(0, 1, 0, "R[-1]C").unwrap();
        drop(rt);
        assert_eq!(wb.formula_at(0, 1, 0).map(|s| s.as_ref()), Some("A1"));
    }

    /// **DE locale input canonicalizes to EN.** `SUM(2,5; 3,5)`
    /// (DE — `,` decimal, `;` arg sep) → `SUM(2.5, 3.5)` (EN canon).
    #[test]
    fn set_formula_canonicalizes_de_locale_to_en() {
        let mut wb = make_runtime_workbook();
        wb.set_locale(ql_types::Locale::De);
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "SUM(2,5; 3,5)").unwrap();
        drop(rt);
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("SUM(2.5, 3.5)")
        );
    }

    /// **`@A1` (implicit intersection) survives canonicalization.**
    /// The `@` operator is mode + locale invariant per design § 3.3.
    #[test]
    fn set_formula_preserves_at_through_canonicalization() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "@A1").unwrap();
        drop(rt);
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("@A1"));
    }

    #[test]
    fn set_reference_mode_op_round_trips_through_replay() {
        // Producer side: append Op::SetReferenceMode + Op::SetLocale.
        let mut producer_wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
            rt.set_reference_mode(ql_types::ReferenceMode::R1C1)
                .unwrap();
            rt.set_locale(ql_types::Locale::De).unwrap();
        }
        // Replay side: fresh workbook, replay the log → same state.
        let mut replay_wb = make_runtime_workbook();
        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
        assert_eq!(replay_wb.reference_mode(), ql_types::ReferenceMode::R1C1);
        assert_eq!(replay_wb.locale(), ql_types::Locale::De);
    }

    // ===================================================================
    // W5-148 (Phase 4.9.L) — round-trip + edge case verification.
    //
    // End-to-end property tests across the R1C1 + locales + `@`
    // trifecta. These exercise the full lex/parse/bind/eval/print/
    // op-log/canonical-storage stack assembled across W5-138 to
    // W5-147; the goal is to pin observable invariants so the
    // closing megaudit (4.9.O) has a known-good baseline.
    // ===================================================================

    /// **Mixed-relativity R1C1 range REJECTED at parse time.**
    /// `R1C1:R[10]C5` mixes absolute + relative on the row axis →
    /// `ParseError::R1C1MixedRelativity` (W5-139). The runtime
    /// surfaces this as `RuntimeError::Parse(_)`.
    #[test]
    fn mixed_relativity_r1c1_range_rejected_at_set_formula() {
        let mut wb = make_runtime_workbook();
        wb.set_reference_mode(ql_types::ReferenceMode::R1C1);
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.set_formula(0, 0, 0, "R1C1:R[10]C5").unwrap_err();
        assert!(matches!(err, RuntimeError::Parse(_)));
    }

    /// **`Sales[@Col]` vs `@Sales[Qty]` AST disambiguation.**
    /// Both produce structured-ref evaluation narrowed to the
    /// formula's row, but the parser path differs (in-bracket `@`
    /// stays in StructuredRef.bracket_content; outside-bracket `@`
    /// is `Token::At`). After W5-144's binder patch they
    /// canonicalize to ExprPlan::StructuredRef with
    /// `is_this_row: true`, so the OUTPUT VALUE is identical.
    #[test]
    fn structured_ref_at_inside_vs_outside_brackets_eval_identically() {
        use ql_storage::{TableColumn, TableMetadata};
        let mut wb = make_runtime_workbook();
        let table = TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 3,
            cols: 1,
            has_header: true,
            has_totals: false,
            columns: vec![TableColumn {
                id: 0,
                name: Arc::from("qty"),
                display: Arc::from("Qty"),
                totals_function: None,
            }],
        };
        wb.tables_mut().insert(Arc::clone(&table.name), table);
        wb.put(
            ql_types::Address::new(0, 1, 0),
            ql_types::Value::Number(10.0),
        );
        wb.put(
            ql_types::Address::new(0, 2, 0),
            ql_types::Value::Number(20.0),
        );

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // `Sales[@Qty]` at row 1 — narrows to row 1's Qty = 10.
        let v1 = rt.set_formula(0, 1, 5, "Sales[@Qty]").unwrap();
        // `@Sales[Qty]` at row 1 — also narrows to row 1's Qty = 10.
        let v2 = rt.set_formula(0, 1, 6, "@Sales[Qty]").unwrap();
        assert_eq!(v1, ql_types::Value::Number(10.0));
        assert_eq!(v2, ql_types::Value::Number(10.0));
    }

    /// **`@A:A` (whole-column inside `@`) evals at formula's row.**
    /// `@A:A` at cell (3, 1) → reads A4 (row 3, col 0).
    #[test]
    fn at_whole_column_evals_to_anchor_row() {
        let mut wb = make_runtime_workbook();
        // Put a marker at A4 so we can distinguish.
        wb.put(
            ql_types::Address::new(0, 3, 0),
            ql_types::Value::Number(99.0),
        );
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 3, 1, "@A:A").unwrap();
        assert_eq!(v, ql_types::Value::Number(99.0));
    }

    /// **`@1:1` (whole-row inside `@`) evals at formula's col.**
    /// `@1:1` at cell (3, 2) → reads C1 (row 0, col 2).
    #[test]
    fn at_whole_row_evals_to_anchor_col() {
        let mut wb = make_runtime_workbook();
        wb.put(
            ql_types::Address::new(0, 0, 2),
            ql_types::Value::Number(42.0),
        );
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 3, 2, "@1:1").unwrap();
        assert_eq!(v, ql_types::Value::Number(42.0));
    }

    /// **`Sheet1!@A1` resolves with sheet prefix + `@` wrapping.**
    /// The sheet binds to the inner CellRef (W5-143
    /// `apply_sheet_to_term` recurses INTO the wrapper).
    #[test]
    fn sheet_qualified_at_ref_resolves_correctly() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S");
        let s1 = wb.add_sheet("Other");
        wb.put(
            ql_types::Address::new(s1, 0, 0),
            ql_types::Value::Number(7.0),
        );
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Use the actual sheet name "Other" (s1).
        let v = rt.set_formula(s0, 0, 0, "Other!@A1").unwrap();
        assert_eq!(v, ql_types::Value::Number(7.0));
    }

    /// **R1C1 input + EN locale + same anchor → A1 canonical
    /// stored.** Round-trip: write `R1C1+R2C2` in R1C1 mode,
    /// reload (replay), the stored canonical text re-binds and
    /// evaluates identically.
    #[test]
    fn r1c1_input_round_trips_through_oplog_replay() {
        // Start at default A1 so the runtime's set_reference_mode
        // call actually emits an Op::SetReferenceMode (no-op when
        // the value already matches).
        let mut producer_wb = make_runtime_workbook();
        producer_wb.put(
            ql_types::Address::new(0, 0, 0),
            ql_types::Value::Number(5.0),
        );
        producer_wb.put(
            ql_types::Address::new(0, 1, 1),
            ql_types::Value::Number(11.0),
        );
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let producer_value = {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
            rt.set_reference_mode(ql_types::ReferenceMode::R1C1)
                .unwrap();
            rt.set_formula(0, 5, 5, "R1C1+R2C2").unwrap()
        };
        assert_eq!(producer_value, ql_types::Value::Number(16.0));

        // Replay into a fresh workbook.
        let mut replay_wb = make_runtime_workbook();
        replay_wb.put(
            ql_types::Address::new(0, 0, 0),
            ql_types::Value::Number(5.0),
        );
        replay_wb.put(
            ql_types::Address::new(0, 1, 1),
            ql_types::Value::Number(11.0),
        );
        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();

        // Replay restored R1C1 mode + the canonical (A1+EnUs) formula.
        assert_eq!(replay_wb.reference_mode(), ql_types::ReferenceMode::R1C1);
        // The stored formula text is the CANONICAL (A1+EnUs) form.
        assert_eq!(
            replay_wb.formula_at(0, 5, 5).map(|s| s.as_ref()),
            Some("$A$1 + $B$2")
        );
        // Recompute to verify the canonical text evaluates correctly.
        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
        let _ = rt.recompute_all();
        drop(rt);
        assert_eq!(
            replay_wb.read(ql_types::Address::new(0, 5, 5)),
            ql_types::Value::Number(16.0)
        );
    }

    /// **DE locale input round-trips through oplog replay.**
    /// `SUM(2,5; 3,5)` in DE locale → canonical `SUM(2.5, 3.5)` in
    /// op-log → replay against fresh workbook → identical result.
    #[test]
    fn de_locale_input_round_trips_through_oplog_replay() {
        let mut producer_wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let producer_value = {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
            // Start at default EnUs so the runtime's set_locale emits
            // an Op::SetLocale (no-op when value matches).
            rt.set_locale(ql_types::Locale::De).unwrap();
            rt.set_formula(0, 0, 0, "SUM(2,5; 3,5)").unwrap()
        };
        assert_eq!(producer_value, ql_types::Value::Number(6.0));

        let mut replay_wb = make_runtime_workbook();
        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
        assert_eq!(replay_wb.locale(), ql_types::Locale::De);
        assert_eq!(
            replay_wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("SUM(2.5, 3.5)")
        );
    }

    /// **`@` survives op-log replay.** `@A1` in producer → `@A1` in
    /// replayed workbook (mode/locale-invariant).
    #[test]
    fn at_operator_round_trips_through_oplog_replay() {
        let mut producer_wb = make_runtime_workbook();
        producer_wb.put(
            ql_types::Address::new(0, 0, 0),
            ql_types::Value::Number(42.0),
        );
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let producer_value = {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
            rt.set_formula(0, 1, 0, "@A1").unwrap()
        };
        assert_eq!(producer_value, ql_types::Value::Number(42.0));

        let mut replay_wb = make_runtime_workbook();
        replay_wb.put(
            ql_types::Address::new(0, 0, 0),
            ql_types::Value::Number(42.0),
        );
        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
        assert_eq!(
            replay_wb.formula_at(0, 1, 0).map(|s| s.as_ref()),
            Some("@A1")
        );
    }

    /// **Switching reference_mode does NOT mutate stored formula
    /// text.** Per design § 4.4 storage canon, the stored text is
    /// always A1+EnUs regardless of the current workbook display
    /// mode. Verifies the canonical contract: changing the
    /// reference_mode is a display-only preference.
    #[test]
    fn reference_mode_change_leaves_stored_formula_text_canonical() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(0, 0, 0, "A1+B2").unwrap();
        }
        let stored = wb.formula_at(0, 0, 0).map(|s| s.as_ref().to_owned());
        // Switch to R1C1.
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_reference_mode(ql_types::ReferenceMode::R1C1)
                .unwrap();
        }
        // Stored text unchanged (still canonical A1+EnUs).
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref().to_owned()),
            stored
        );
    }

    /// **DE locale change does NOT mutate stored formula text.**
    /// Same canonical contract — locale switch is display-only.
    #[test]
    fn locale_change_leaves_stored_formula_text_canonical() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(0, 0, 0, "SUM(1.5, 2.5)").unwrap();
        }
        let stored = wb.formula_at(0, 0, 0).map(|s| s.as_ref().to_owned());
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_locale(ql_types::Locale::De).unwrap();
        }
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref().to_owned()),
            stored
        );
    }

    /// **`@scalar` is idempotent: `@5` evaluates to `5`.**
    /// Design § 3.3 rule 1 — scalar inputs pass through unchanged.
    #[test]
    fn at_scalar_idempotent_through_eval() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 0, 0, "@5").unwrap();
        assert_eq!(v, ql_types::Value::Number(5.0));
    }

    /// **`@SUM(scalar args)` evaluates identically to `SUM(scalar args)`.**
    /// Design § 3.3 rule 8 — function inner with scalar return. SUM
    /// of scalar args returns scalar so the `@` wrap is a no-op.
    /// (Literal `SUM(A1:A3)` over a Range needs aggregate-arg binding
    /// which v1 routes via named ranges only; using scalar args here
    /// keeps the test focused on the `@` semantics.)
    #[test]
    fn at_function_with_scalar_return_passes_through() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v_no_at = rt.set_formula(0, 5, 0, "SUM(1, 2, 3)").unwrap();
        let v_with_at = rt.set_formula(0, 5, 1, "@SUM(1, 2, 3)").unwrap();
        assert_eq!(v_no_at, ql_types::Value::Number(6.0));
        assert_eq!(v_with_at, ql_types::Value::Number(6.0));
    }

    // ===================================================================
    // W5-149 (Phase 4.9.M) — coverage matrix (mode × locale × @-presence).
    //
    // Systematic table-driven verification that
    //   set_formula(text) → stored canonical text
    // is correct for every (mode, locale, @-presence) cell. The
    // canonical contract per design § 4.4: stored text is ALWAYS
    // A1+EnUs regardless of input mode/locale; `@` is mode + locale
    // invariant and is preserved verbatim through canonicalization.
    //
    // Matrix dimensions:
    //   mode      ∈ {A1, R1C1}                          (2)
    //   locale    ∈ {EnUs, De, Fr}                       (3)
    //   @-presence ∈ {none, prefix-cell, prefix-function,
    //                inside-arg, prefix-rel-ref}        (5)
    //
    // = 30 cells. Each cell specifies the input formula in its
    // (mode, locale) source syntax + the expected canonical
    // (A1+EnUs) output. The driver feeds set_formula at a fixed
    // anchor (0, 0) and asserts the stored text matches.
    // ===================================================================

    /// **Coverage matrix cell.** Anchor is always `(0, 0, 0)` so the
    /// expected canonical column can hardcode A1 letters.
    struct MatrixCell {
        mode: ql_types::ReferenceMode,
        locale: ql_types::Locale,
        input: &'static str,
        expected_canonical: &'static str,
    }

    /// Build the full 30-cell matrix.
    fn coverage_matrix() -> Vec<MatrixCell> {
        use ql_types::{Locale, ReferenceMode};
        let mut cells = Vec::with_capacity(30);

        // ----- @-presence = none -----
        for locale in [Locale::EnUs, Locale::De, Locale::Fr] {
            cells.push(MatrixCell {
                mode: ReferenceMode::A1,
                locale,
                input: "A1",
                expected_canonical: "A1",
            });
        }
        for locale in [Locale::EnUs, Locale::De, Locale::Fr] {
            cells.push(MatrixCell {
                mode: ReferenceMode::R1C1,
                locale,
                input: "R1C1",
                expected_canonical: "$A$1",
            });
        }

        // ----- @-presence = prefix-cell -----
        for locale in [Locale::EnUs, Locale::De, Locale::Fr] {
            cells.push(MatrixCell {
                mode: ReferenceMode::A1,
                locale,
                input: "@A1",
                expected_canonical: "@A1",
            });
        }
        for locale in [Locale::EnUs, Locale::De, Locale::Fr] {
            cells.push(MatrixCell {
                mode: ReferenceMode::R1C1,
                locale,
                input: "@R1C1",
                expected_canonical: "@$A$1",
            });
        }

        // ----- @-presence = prefix-function -----
        // EN: arg sep `,`. DE+FR: arg sep `;`.
        cells.push(MatrixCell {
            mode: ReferenceMode::A1,
            locale: Locale::EnUs,
            input: "@SUM(1, 2)",
            expected_canonical: "@SUM(1, 2)",
        });
        cells.push(MatrixCell {
            mode: ReferenceMode::A1,
            locale: Locale::De,
            input: "@SUM(1; 2)",
            expected_canonical: "@SUM(1, 2)",
        });
        cells.push(MatrixCell {
            mode: ReferenceMode::A1,
            locale: Locale::Fr,
            input: "@SUM(1; 2)",
            expected_canonical: "@SUM(1, 2)",
        });
        cells.push(MatrixCell {
            mode: ReferenceMode::R1C1,
            locale: Locale::EnUs,
            input: "@SUM(R1C1, R2C2)",
            expected_canonical: "@SUM($A$1, $B$2)",
        });
        cells.push(MatrixCell {
            mode: ReferenceMode::R1C1,
            locale: Locale::De,
            input: "@SUM(R1C1; R2C2)",
            expected_canonical: "@SUM($A$1, $B$2)",
        });
        cells.push(MatrixCell {
            mode: ReferenceMode::R1C1,
            locale: Locale::Fr,
            input: "@SUM(R1C1; R2C2)",
            expected_canonical: "@SUM($A$1, $B$2)",
        });

        // ----- @-presence = inside-arg -----
        cells.push(MatrixCell {
            mode: ReferenceMode::A1,
            locale: Locale::EnUs,
            input: "SUM(@A1, B2)",
            expected_canonical: "SUM(@A1, B2)",
        });
        cells.push(MatrixCell {
            mode: ReferenceMode::A1,
            locale: Locale::De,
            input: "SUM(@A1; B2)",
            expected_canonical: "SUM(@A1, B2)",
        });
        cells.push(MatrixCell {
            mode: ReferenceMode::A1,
            locale: Locale::Fr,
            input: "SUM(@A1; B2)",
            expected_canonical: "SUM(@A1, B2)",
        });
        cells.push(MatrixCell {
            mode: ReferenceMode::R1C1,
            locale: Locale::EnUs,
            input: "SUM(@R1C1, R2C2)",
            expected_canonical: "SUM(@$A$1, $B$2)",
        });
        cells.push(MatrixCell {
            mode: ReferenceMode::R1C1,
            locale: Locale::De,
            input: "SUM(@R1C1; R2C2)",
            expected_canonical: "SUM(@$A$1, $B$2)",
        });
        cells.push(MatrixCell {
            mode: ReferenceMode::R1C1,
            locale: Locale::Fr,
            input: "SUM(@R1C1; R2C2)",
            expected_canonical: "SUM(@$A$1, $B$2)",
        });

        // ----- @-presence = prefix-rel-ref -----
        // Relative R1C1 inside `@`. At anchor (0, 0), `R[1]C[1]` →
        // B2; `@R[1]C[1]` → `@B2`. A1 mode equivalent for the
        // same anchor: `B2` is the relative-coord form.
        for locale in [Locale::EnUs, Locale::De, Locale::Fr] {
            cells.push(MatrixCell {
                mode: ReferenceMode::A1,
                locale,
                input: "@B2",
                expected_canonical: "@B2",
            });
        }
        for locale in [Locale::EnUs, Locale::De, Locale::Fr] {
            cells.push(MatrixCell {
                mode: ReferenceMode::R1C1,
                locale,
                input: "@R[1]C[1]",
                expected_canonical: "@B2",
            });
        }

        cells
    }

    /// **Coverage matrix driver.** Walks all 30 cells; for each,
    /// constructs a workbook in the cell's (mode, locale) state,
    /// calls `set_formula(0, 0, 0, input)`, and asserts the stored
    /// text equals `expected_canonical`.
    #[test]
    fn coverage_matrix_mode_locale_at_presence_30_cells() {
        let cells = coverage_matrix();
        assert_eq!(
            cells.len(),
            30,
            "matrix should have exactly 30 cells (2 modes × 3 locales × 5 @-presence)"
        );
        let reg = default_registry();
        for (i, cell) in cells.iter().enumerate() {
            let mut wb = make_runtime_workbook();
            wb.set_reference_mode(cell.mode);
            wb.set_locale(cell.locale);
            {
                let mut rt = WorkbookRuntime::new(&mut wb, &reg);
                rt.set_formula(0, 0, 0, cell.input).unwrap_or_else(|e| {
                    panic!(
                        "matrix cell {i} ({:?}, {:?}, {:?}) — set_formula failed: {:?}",
                        cell.mode, cell.locale, cell.input, e
                    );
                });
            }
            let stored = wb.formula_at(0, 0, 0).map(|s| s.as_ref().to_owned());
            assert_eq!(
                stored.as_deref(),
                Some(cell.expected_canonical),
                "matrix cell {i} ({:?}, {:?}, {:?}) — stored canonical mismatch",
                cell.mode,
                cell.locale,
                cell.input
            );
        }
    }

    /// **Coverage matrix has no duplicate cells.** Every
    /// (mode, locale, input) triple is unique — sanity that the
    /// matrix builder didn't accidentally repeat a row.
    #[test]
    fn coverage_matrix_has_no_duplicates() {
        use std::collections::HashSet;
        let cells = coverage_matrix();
        let mut seen = HashSet::new();
        for cell in &cells {
            let key = format!("{:?}|{:?}|{}", cell.mode, cell.locale, cell.input);
            assert!(seen.insert(key.clone()), "duplicate matrix cell: {key}");
        }
    }

    /// **4.9.O audit verification:** plan cache collision when
    /// `@<range>` is used at multiple cells in the same runtime
    /// session. The W5-144 binder narrows `@A:A` at bind time using
    /// site.cell, producing a cell-specific `ExprPlan::CellRef`.
    /// But `PlanCacheKey` is `(canonical_text, sheet, name_gen)` —
    /// no cell coords. Two cells in the same sheet with the same
    /// canonical text `@A:A` would hit the cache and get the FIRST
    /// call's narrowed plan, reading the wrong row.
    ///
    /// This test must PASS for the engine to be correct under the
    /// "same `@<range>` formula at multiple cells" workload.
    #[test]
    fn plan_cache_at_range_collision_across_cells_regression() {
        let mut wb = make_runtime_workbook();
        wb.put(
            ql_types::Address::new(0, 3, 0),
            ql_types::Value::Number(11.0),
        );
        wb.put(
            ql_types::Address::new(0, 5, 0),
            ql_types::Value::Number(99.0),
        );
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v1 = rt.set_formula(0, 3, 1, "@A:A").unwrap();
        assert_eq!(
            v1,
            ql_types::Value::Number(11.0),
            "first @A:A at row 3 must read A4"
        );
        let v2 = rt.set_formula(0, 5, 1, "@A:A").unwrap();
        assert_eq!(
            v2,
            ql_types::Value::Number(99.0),
            "second @A:A at row 5 must read A6, NOT the cached A4 plan"
        );
    }

    /// **Coverage matrix axis dimensions.** Sanity-pin that the
    /// matrix has exactly the documented per-axis counts (so a
    /// future cell-addition forces the axis-count assertion to
    /// trip until the doc is updated).
    #[test]
    fn coverage_matrix_dimension_counts() {
        // `Locale` / `ReferenceMode` don't derive `Hash`, so we
        // count by stringifying their Debug form (cheap + readable).
        use std::collections::HashSet;
        let cells = coverage_matrix();
        let modes: HashSet<String> = cells.iter().map(|c| format!("{:?}", c.mode)).collect();
        let locales: HashSet<String> = cells.iter().map(|c| format!("{:?}", c.locale)).collect();
        assert_eq!(modes.len(), 2, "expected 2 modes");
        assert_eq!(locales.len(), 3, "expected 3 locales");
        assert_eq!(cells.len(), 30, "expected 30 cells (2 × 3 × 5 @-presence)");
    }
}
