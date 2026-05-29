//! Recompute pipeline for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.6 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Five
//! methods covering the formula-recompute surface (full pass +
//! incremental + per-cell helpers). Pure code move; no behavior
//! change.
//!
//! Methods:
//! - [`WorkbookRuntime::recompute_all`] — HashMap-order full pass
//!   with the Tier C1 cycle-detection pre-pass (2026-05-18,
//!   commit 3451d90a03f). Used by `.qbook` load + replay.
//! - [`WorkbookRuntime::recompute_dirty`] — incremental graph-
//!   driven recompute via Tarjan SCC over the attached
//!   `CalcgraphSession`'s dirty set; cycled members get `#CIRC!`.
//!   The performance path with session-attached callers (IDE).
//! - `try_recompute_one_cached` (private) — lex+parse+bind+eval
//!   one formula via the `PlanCache`.
//! - `try_recompute_with_aggregate_cache` (private) — same path
//!   with `AggregateCache` for `SUM(NamedRange)`-style cache
//!   hits (Phase 3.6 AGG-3-01).
//! - `try_recompute_with_simd_profile` (private) — recompute
//!   with the SIMD-classification + spill-management orchestrator
//!   used by `recompute_dirty`'s sorted-node loop.

use std::sync::Arc;

use ql_formula_syntax::{lex, lex_with, parse};
use ql_storage::{SpillShape, Workbook};
use ql_types::{ColId, ErrorValue, RowId, SheetId, Value};

use crate::env::WorkbookEnv;
use crate::plan::{bind_with_site, BindError, BindSite, ExprPlan};
use crate::plan_cache::PlanCacheKey;

use super::{RecomputeFailure, RecomputeResult, RuntimeError, WorkbookRuntime};

/// **6.4-3d (2026-05-29; megaudit blocker D2):** does the bound plan directly
/// call any registered UDF? Reuses the exhaustive dependency walker, so it
/// covers every `ExprPlan` shape and nested calls — and, matching dispatch
/// semantics, does NOT descend ISREF's lazy-shape arg (which never reaches the
/// worker). It therefore answers precisely "would a UDF actually dispatch when
/// this cell recomputes." Used to PRESERVE a saved UDF-cell value when no worker
/// is configured (the recompute would otherwise overwrite it with `#CALC!`).
fn plan_references_udf(plan: &ExprPlan, registry: &ql_functions::FunctionRegistry) -> bool {
    let mut deps = crate::calcgraph_session::FormulaDeps::default();
    crate::calcgraph_session::walk_plan_for_deps(plan, &mut deps, registry);
    deps.functions_used
        .iter()
        .any(|name| registry.udf_handle(name).is_some())
}

impl<'a> WorkbookRuntime<'a> {
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
            // **6.4-0 audit-fix H2 (2026-05-28):** the original
            // `rebuild_from_workbook(wb)` zero-arg call silently fell
            // back to `ql_functions::default_registry()`, ignoring
            // `self.registry` — benign today (both registries are
            // builtin-equivalent) but at 6.4 with UDFs the production
            // recompute_all path would walk against a UDF-free
            // registry while live `set_formula` paths see the
            // session-scoped one. Silent divergence between
            // load/replay and live editing. The substrate already
            // shipped `_with_registry`; this site just missed the
            // migration. (Caught by the Opus reviewer lane in cycle 2
            // audit; Codex lane verified populate/cleanup symmetry
            // but missed the production divergence.)
            let mut session =
                CalcgraphSession::rebuild_from_workbook_with_registry(self.workbook, self.registry)
                    .session;
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
        // inc.2c-3: the full-pass path rewrites every formula cell, so report
        // them all as changed (a safe over-report for the delta change-log; the
        // cycled cells were written to `#CIRC!` in the pre-pass above).
        let mut changed_cells: Vec<(SheetId, RowId, ColId)> = Vec::with_capacity(attempted);

        for (sheet, row, col, formula_text) in entries {
            changed_cells.push((sheet, row, col));
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
            // 6.4-3d (blocker D2): the LOAD path — preserve saved UDF values
            // when no worker is configured (`true`).
            match self.try_recompute_one_cached(sheet, row, col, &formula_text, true) {
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
                    //
                    // **Phase 5.2 D-3 closure (2026-05-19):** also map
                    // `BindError::UnknownSheet` to `#NAME?`. Surfaces
                    // in Phase 5 multi-peer collaboration: peer A
                    // renames sheet `S → X`; peer B concurrently
                    // writes `=S!A1+1`; merged log → B's formula
                    // references the now-missing sheet `S`. Phase
                    // 5.1 audit (Codex V5) verified the pre-fix
                    // behavior was to leave the cell with its stale
                    // pre-recompute value AND emit a
                    // RecomputeFailure — worse than `#NAME?` from
                    // the user's perspective. This maps it cleanly.
                    if let RuntimeError::Bind(
                        BindError::UnknownTable(_)
                        | BindError::UnknownTableColumn { .. }
                        | BindError::UnknownSheet(_),
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
            changed_cells,
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
                //   b) Has named-range OR literal-range deps — V1
                //      conservatively re-evals (we don't track per-cell-in-
                //      range changes yet; 6.4-3d C1 added literal_ranges for
                //      value-consuming UDF args like `=MYUDF(A1:A2)`).
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
                    if !deps.named_ranges.is_empty() || !deps.literal_ranges.is_empty() {
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
                // 6.4-3d (blocker D2): live-edit path — do NOT preserve
                // (`false`); a UDF cell with no worker recomputes honestly
                // (e.g. a just-registered UDF goes `#NAME?` → `#CALC!`).
                match self.try_recompute_with_simd_profile(sheet, row, col, &text, agg_cache, false)
                {
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
                                let fn_gen = self.registry.fn_generation();
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
                                    fn_gen,
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
                                                self.registry,
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
                                session.reextract_deps(
                                    rn,
                                    plan.as_ref(),
                                    self.workbook,
                                    self.registry,
                                );
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
                        //
                        // **Phase 5.2 D-3 closure (2026-05-19):** also
                        // map `BindError::UnknownSheet` here. Mirror of
                        // the `recompute_all` change for cross-sheet
                        // bind failures (rename-sheet × concurrent
                        // formula edit in Phase 5 multi-peer merge).
                        if let RuntimeError::Bind(
                            BindError::UnknownTable(_)
                            | BindError::UnknownTableColumn { .. }
                            | BindError::UnknownSheet(_),
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
        // inc.2c-3: surface the precise value-changed set (the VEQ `changed`
        // set accumulated across fixed-point iterations) so the owning session's
        // delta change-log captures recompute-changed dependents.
        let changed_cells: Vec<(SheetId, RowId, ColId)> = changed.into_iter().collect();
        Some(RecomputeResult {
            attempted,
            succeeded,
            failures,
            skipped_value_equality,
            simd_classified,
            changed_cells,
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
        // **6.4-3d (blocker D2):** see `try_recompute_with_simd_profile`. Only
        // the load path (`recompute_all`) passes `true` — preserving a saved
        // UDF value when no worker is configured.
        preserve_saved_udf_when_no_worker: bool,
    ) -> Result<Value, RuntimeError> {
        self.try_recompute_with_aggregate_cache(
            sheet,
            row,
            col,
            formula_text,
            &crate::aggregate_cache::NoAggregateCache,
            preserve_saved_udf_when_no_worker,
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
        // **6.4-3d (blocker D2):** see `try_recompute_with_simd_profile`.
        preserve_saved_udf_when_no_worker: bool,
    ) -> Result<Value, RuntimeError> {
        self.try_recompute_with_simd_profile(
            sheet,
            row,
            col,
            formula_text,
            agg_cache,
            preserve_saved_udf_when_no_worker,
        )
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
        // **6.4-3d (megaudit blocker D2):** when `true` AND no worker is
        // configured, a formula that calls a UDF PRESERVES its existing stored
        // value instead of recomputing to `#CALC!`. Only the LOAD path
        // (`recompute_all` over a freshly-loaded `.qbook`, where the stored
        // value IS the trustworthy saved value) passes `true`. `recompute_dirty`
        // passes `false`: there the stored value may be stale or an unrelated
        // error (e.g. a just-registered UDF whose cell was `#NAME?` must become
        // `#CALC!`, not stay `#NAME?`), so it must NOT be preserved.
        preserve_saved_udf_when_no_worker: bool,
    ) -> Result<(Value, bool, Option<SpillShape>, Option<SpillShape>), RuntimeError> {
        let name_gen = self.workbook.names().generation();
        let fn_gen = self.registry.fn_generation();
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
            fn_gen,
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
                        self.registry,
                    )?)
                })?;

        // Phase 3.9: classify the plan against the SIMD kernel set.
        // Pure function over the plan tree; no allocation.
        let simd_eligible = crate::lower::classify(plan.as_ref()).is_applicable();

        // **6.4-3d (2026-05-29; megaudit blocker D2):** if this session has NO
        // UDF worker AND the formula calls a UDF, PRESERVE the cell's existing
        // computed value instead of recomputing it to `#CALC!` — which would
        // destroy a value that was saved while a worker WAS present (`.qbook`
        // persists computed values). Return the current value WITHOUT clearing
        // the spill (the `clear_spill_if_present` below is skipped by this early
        // return), so a saved spilled-array footprint survives too. Gated on
        // `is_none()` so a worker-present session pays zero cost. The value
        // re-derives to a fresh result once a worker is injected + `recalc_all`
        // runs (per `set_udf_worker`'s doc). Soundness for DEPENDENTS: a skipped
        // `B1=MYUDF(A1)` keeps its stored value, so `C1=B1+1` reads it and
        // recomputes correctly in any order.
        if preserve_saved_udf_when_no_worker
            && self.udf_worker.is_none()
            && plan_references_udf(plan.as_ref(), self.registry)
        {
            let existing = workbook.read(ql_types::Address::new(sheet, row, col));
            return Ok((existing, simd_eligible, None, None));
        }

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
            // **6.4-3c (2026-05-29):** carry the session's UDF worker so a
            // recomputed `=MYUDF(A1)` dispatches to the Python worker (and an
            // array return spills via the cell-boundary path below).
            let env = WorkbookEnv::with_formula_cell_worker_and_diagnostics(
                self.workbook,
                ql_types::Address::new(sheet, row, col),
                self.udf_worker,
                self.udf_diagnostics,
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
    use std::sync::LazyLock;

    use ql_functions::{default_registry, FunctionRegistry};
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value};

    use crate::plan::BindError;
    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    /// **6.4-1 (2026-05-28; H1):** shared default registry — see
    /// `crates/ql-exec/src/plan.rs::tests::TEST_REGISTRY` for the
    /// pattern. The binder now needs metadata to route range args.
    static TEST_REGISTRY: LazyLock<FunctionRegistry> = LazyLock::new(default_registry);

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
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
        let plan = bind(&expr, 0, &TEST_REGISTRY).unwrap();
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
        let plan = bind(&expr, 0, &TEST_REGISTRY).unwrap();
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

    // ===== Phase 5.2 D-3 closure (2026-05-19) =====
    //
    // BindError::UnknownSheet → #NAME? mapping in recompute_all +
    // recompute_dirty. Phase 5.1 audit (Codex V5) verified the
    // pre-fix behavior was to leave the cell with a stale value
    // AND emit a RecomputeFailure for unknown-sheet bind errors —
    // worse than #NAME?. These tests verify the closure works for
    // both recompute paths.

    /// `recompute_all` maps cross-sheet ref to a missing sheet name
    /// to `#NAME?`. Pre-D-3 the cell retained stale state + emitted
    /// a RecomputeFailure.
    #[test]
    fn recompute_all_maps_unknown_sheet_to_name_error() {
        use ql_storage::Workbook;
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("Sheet1");
        let s1 = wb.add_sheet("Sheet2");
        wb.put_at(s1, 0, 0, Value::Number(42.0));
        // Set a formula on Sheet1 referencing Sheet2!A1.
        wb.put_formula(s0, 0, 0, "Sheet2!A1 + 1");

        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let r = rt.recompute_all();
            // Both formulas (in case there are others) succeed when
            // sheet exists.
            assert!(r.failures.is_empty());
            assert_eq!(
                wb.read(ql_types::Address::new(s0, 0, 0)),
                Value::Number(43.0),
                "baseline: formula evaluates correctly when sheet exists"
            );
        }

        // Now hand-mutate to reference a nonexistent sheet.
        // `Sheet2` exists in the workbook but rename it to break
        // the formula's reference (formula text is canonical and
        // not auto-rewritten via this low-level mutation path).
        wb.put_formula(s0, 0, 0, "DeletedSheet!A1 + 1");

        let r = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.recompute_all()
        };

        assert!(
            r.failures.is_empty(),
            "unknown-sheet bind error must map to #NAME?, not a RecomputeFailure (got: {:?})",
            r.failures
        );
        assert_eq!(
            wb.read(ql_types::Address::new(s0, 0, 0)),
            Value::Error(ErrorValue::Name),
            "cell must show #NAME? after rebind to missing sheet"
        );
    }

    /// `recompute_dirty` maps cross-sheet ref to a missing sheet name
    /// to `#NAME?`. Mirror of the recompute_all test above.
    ///
    /// Setup mirrors `recompute_dirty_writes_circ_error_for_cycle_members`
    /// (the W5-37 SCH-3-02 reference test in workbook_runtime/mod.rs):
    /// pre-populate the workbook with the unbindable formula via the
    /// low-level `put_formula` (bypasses set_formula's bind-fail
    /// short-circuit), rebuild a CalcgraphSession, then mark the
    /// cell dirty manually so recompute_dirty processes it.
    #[test]
    fn recompute_dirty_maps_unknown_sheet_to_name_error() {
        use crate::CalcgraphSession;
        use ql_storage::Workbook;
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("Sheet1");
        // Hand-write the formula text directly. `WorkbookRuntime::set_formula`
        // would refuse because bind fails on the unknown sheet ref —
        // but the .qbook cold-load path uses `put_formula` to seed
        // formula text without binding, and Phase 5 op-log replay
        // does the same. This test recreates that scenario.
        wb.put_formula(s0, 0, 0, "DeletedSheet!A1 + 1");

        let reg = default_registry();
        // Rebuild a session from the workbook so the formula cell
        // gets a node. `on_set_value(s0, 0, 0)` doesn't dirty A1
        // itself (it dirties formulas that READ A1), so use the
        // crate-private `mark_dirty` to explicitly dirty A1's own
        // node.
        let rebuild = CalcgraphSession::rebuild_from_workbook(&wb);
        let mut graph = rebuild.session;
        let node = graph
            .cell_node_for(s0, 0, 0)
            .expect("formula cell has a node after rebuild");
        graph.mark_dirty(node);

        let r = {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.recompute_dirty().unwrap()
        };
        assert!(
            r.failures.is_empty(),
            "unknown-sheet must map to #NAME? in recompute_dirty too (got: {:?})",
            r.failures
        );
        assert_eq!(
            wb.read(ql_types::Address::new(s0, 0, 0)),
            Value::Error(ErrorValue::Name),
            "cell must show #NAME? for unknown-sheet bind error"
        );
    }
}
