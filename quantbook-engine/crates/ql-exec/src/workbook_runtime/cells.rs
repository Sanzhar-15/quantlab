//! Cell mutation API for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.7 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Six
//! producer-side cell-mutation methods + 3 private spill helpers.
//! Largest method-LOC submodule: `set_formula` alone is 417 LOC.
//! Pure code move; no behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::set_formula`] — lex → parse → bind → eval →
//!   put_at + put_formula. Phase 1 W5-10 + many follow-up
//!   refinements (W5-103 spill writeback, W5-106 SEQUENCE,
//!   W5-107 TRANSPOSE/FILTER, W5-147 canonicalization).
//! - [`WorkbookRuntime::set_value`] — literal write with op-log
//!   emission and spill invalidation (W5-104).
//! - [`WorkbookRuntime::clear_formula`] — strip a cell's formula
//!   association; Phase 2B.5 op-log producer with idempotency.
//! - `write_spill` (private) — write the spill body for array-
//!   returning formulas; runs `clear_spill_if_present` first to
//!   dissolve any pre-existing spill at the anchor.
//! - `write_anchor_error` (private) — write `#SPILL!` (or other
//!   error sigil) at an anchor when spill cannot proceed.
//! - `reextract_spill_footprint_readers` (private) — re-extract
//!   calc-graph deps for every formula reading cells inside a
//!   dissolved or transitioned spill footprint.

use std::sync::Arc;

use ql_formula_syntax::{lex, lex_with, parse, print_with, FormulaSite};
use ql_io::CellWireValue;
use ql_oplog::Op;
use ql_storage::SpillShape;
use ql_types::{ArrayValue, ColId, ErrorValue, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};

use crate::env::WorkbookEnv;
use crate::eval_result::EvalResult;
use crate::plan::{bind_with_site, BindSite};
use crate::plan_cache::PlanCacheKey;

use super::{validate_cell, RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
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
        let fn_gen = self.registry.fn_generation();
        let cell_anchor = if canonical_text.contains('@') {
            Some((row, col))
        } else {
            None
        };
        let cache_key = PlanCacheKey {
            text: Arc::clone(&canonical_text),
            sheet,
            name_gen,
            fn_gen,
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
                        self.registry,
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
            // **6.4-3c (2026-05-29):** also carry the session's UDF worker so
            // `set_formula`'s immediate eval of `=MYUDF(A1)` dispatches to the
            // worker (not only later recomputes).
            let env = WorkbookEnv::with_formula_cell_worker_and_diagnostics(
                self.workbook,
                ql_types::Address::new(sheet, row, col),
                self.udf_worker,
                self.udf_diagnostics,
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

        // **H3 (6.3-0):** record the spill-footprint TARGET cells touched by this
        // edit into the session's per-edit delta collector, so `snapshot_delta`
        // reports the FULL footprint — not just the anchor the session records
        // directly. Independent of (and complementary to) the calcgraph hook
        // pass below, which dirties the same cells for recompute; this is the
        // change-log side. No-op for graph-less runtimes (`spill_footprint`
        // `None`). OLD self footprint → cells that lost their spilled value
        // (resolve to removed); NEW self footprint → cells that gained one
        // (changed); DISSOLVED HOST footprint → host targets that lost the
        // host's value PLUS the host anchor itself (it re-emits `#SPILL!`).
        if let Some(shape) = old_spill_shape {
            self.record_spill_footprint(sheet, row, col, shape, true);
        }
        if let Some(shape) = new_spill_shape {
            self.record_spill_footprint(sheet, row, col, shape, true);
        }
        if let Some((host_anchor, host_shape)) = dissolved_host {
            self.record_spill_footprint(host_anchor.0, host_anchor.1, host_anchor.2, host_shape, false);
        }

        // Phase 3.1: notify calcgraph after the workbook mutation
        // succeeds. Phase 3.2 (2026-05-12): pass the already-bound
        // `ExprPlan` straight from the PlanCache so the hook walks it
        // for cell/range/name + volatile deps without re-binding. The
        // plan is shared by Arc; the hook only needs `&ExprPlan`.
        // **W5-102 (Phase 4.7.I):** also pass `&Workbook` so the dep
        // extractor can rewrite spill-target CellRefs to point at the
        // anchor's formula node (producer-alias model, design § 10.1).
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_set_formula(sheet, row, col, plan.as_ref(), self.workbook, self.registry);
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
            let fn_gen = self.registry.fn_generation();
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
                fn_gen,
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
                        self.registry,
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
                g.reextract_deps(node, plan.as_ref(), self.workbook, self.registry);
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
    ///
    /// **Tier D1 Step 3.7:** visibility raised to `pub(super)` so
    /// `recompute.rs::try_recompute_with_simd_profile` (sibling
    /// submodule) can call it directly. Pre-split this was a
    /// same-module private fn; after the split, sibling-submodule
    /// access requires explicit visibility.
    pub(super) fn write_spill(
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
        // returns None for `Value::Blank` (Blank is the storage default,
        // encoded as the ABSENCE of a `CellRecord`), so a Blank value emits
        // `Op::ClearValue` rather than `Op::PutValue`.
        //
        // **F2 Blank-durability closure (2026-05-27):** previously the Blank
        // case emitted NO op at all on a value-only cell, so replaying the
        // log into a fresh workbook did NOT reproduce the clear (a cell that
        // was `5` then Blank-cleared replayed back to `5`). `Op::ClearValue`
        // now makes every value-clear durable — closing the save/load AND
        // undo (which re-materializes via replay) correctness gap.
        //
        // Phase 2B.7 audit H2 (2026-05-12): when BOTH a value op and
        // ClearFormula need to land (e.g. a Blank set over a formula cell
        // logs `ClearValue` + `ClearFormula`), wrap them in a single
        // `Op::BatchCommit` so the pair is atomic at the Loro level —
        // partial-pair failure (first appended, second fails) is impossible.
        let had_formula = self.workbook.formula_at(sheet, row, col).is_some();
        if let Some(oplog) = self.oplog.as_deref_mut() {
            let mut log_ops: Vec<Op> = Vec::with_capacity(2);
            match CellWireValue::from_value(&value) {
                Some(wire) => log_ops.push(Op::PutValue {
                    sheet,
                    row,
                    col,
                    value: wire,
                }),
                // Blank value: emit the durable value-clear op (F2).
                None => log_ops.push(Op::ClearValue { sheet, row, col }),
            }
            if had_formula {
                log_ops.push(Op::ClearFormula { sheet, row, col });
            }
            match log_ops.len() {
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

        // **H3 (6.3-0):** record the dissolved footprint TARGET cells (about to
        // go Blank) into the delta collector so `snapshot_delta` reports them as
        // removed. Self-anchored: the edited == anchor cell is recorded by the
        // session directly (skip_anchor). Host-anchored: include the host anchor
        // (it re-emits `#SPILL!`); the edited cell is also in the host footprint
        // but the session records it directly (deduped downstream).
        if let Some(shape) = dissolved_self_shape {
            self.record_spill_footprint(sheet, row, col, shape, true);
        }
        if let Some((host_anchor, host_shape)) = dissolved_host {
            self.record_spill_footprint(host_anchor.0, host_anchor.1, host_anchor.2, host_shape, false);
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

    /// **H3 (6.3-0):** record the NON-anchor cells of a spill `shape` anchored
    /// at `(sheet, row, col)` into the lent per-edit spill-footprint collector,
    /// so the owning session folds them into its delta change-log alongside the
    /// edited cell. No-op when no collector is lent (every non-session runtime →
    /// `spill_footprint` is `None`, e.g. op-log replay / standalone transaction).
    ///
    /// `skip_anchor` excludes the anchor cell `(0,0)`: pass `true` for a
    /// SELF-anchored footprint (old/new spill at the EDITED cell — the session
    /// already records the edited == anchor cell directly); pass `false` for a
    /// DISSOLVED-HOST footprint (the host anchor is a DIFFERENT cell that must
    /// also be reported, since it re-emits `#SPILL!` on its next recompute).
    ///
    /// `snapshot_delta` resolves each recorded coord against current committed
    /// state (present → `changed`, absent → `removed`), so recording grown /
    /// shrunk / dissolved targets is uniform — over-reporting an unchanged cell
    /// is harmless (it re-snapshots to its current value) and duplicates are
    /// deduped by the delta walk's `HashSet`.
    fn record_spill_footprint(
        &self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        shape: SpillShape,
        skip_anchor: bool,
    ) {
        let Some(fp) = self.spill_footprint else {
            return;
        };
        let mut fp = fp.borrow_mut();
        for dr in 0..shape.rows {
            for dc in 0..shape.cols {
                if skip_anchor && dr == 0 && dc == 0 {
                    continue;
                }
                fp.push((sheet, row + dr, col + dc));
            }
        }
    }

    // (Tier D1 Step 3.4: set_name / set_sheet_scoped_name moved
    //  to names.rs sibling submodule.)

    // (Tier D1 Step 3.5: 6 table methods + helper moved
    //  to tables.rs sibling submodule.)

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
            // **H3 (6.3-0):** record the dissolved footprint TARGET cells (now
            // Blank) into the delta collector so `snapshot_delta` reports them as
            // removed. The anchor (the cleared cell) is recorded by the session
            // directly, so skip it here.
            self.record_spill_footprint(sheet, row, col, shape, true);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use ql_functions::default_registry;
    use ql_io::CellWireValue;
    use ql_oplog::{Op, OpLog};
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value, MAX_ROW};

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

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

    /// Phase 2B.7 audit (correctness L4): `clear_formula` propagates
    /// `RuntimeError::InvalidSheet` / `InvalidCell` from `validate_cell`.
    ///
    /// Phase 5 V1 D1.a re-partitioning: moved from
    /// `validate.rs::tests` to its natural owning submodule
    /// `cells.rs::tests` (clear_formula lives in cells.rs).
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

    /// D1.a moved from validate.rs::tests (see partner test above).
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

    // (Tier D1 Step 3.6: recompute_all tests moved.)

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

    /// **F2 Blank-durability closure (2026-05-27):** a Blank set on a
    /// value-only cell now emits a durable `Op::ClearValue` (previously
    /// emitted nothing — the value-clear was invisible to the op log and
    /// did NOT reproduce on replay). The op fires even on an
    /// already-blank cell; that is harmless (replay just writes Blank
    /// over Blank) and keeps the producer simple (no pre-read to detect
    /// "already blank").
    #[test]
    fn set_value_blank_on_value_only_cell_emits_clear_value() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // Blank-write on a no-formula cell — emits ONE Op::ClearValue
            // (PutValue is replaced because CellWireValue::from_value(Blank)
            // = None; ClearFormula is skipped because had_formula = false).
            rt.set_value(0, 0, 0, Value::Blank).unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1, "ops were: {ops:?}");
        match &ops[0] {
            Op::ClearValue { sheet, row, col } => {
                assert_eq!((*sheet, *row, *col), (0, 0, 0));
            }
            other => panic!("expected ClearValue, got {other:?}"),
        }
    }

    /// **F2 Blank-durability closure (2026-05-27):** a Blank set over a
    /// formula cell now emits an atomic `BatchCommit { ClearValue,
    /// ClearFormula }` (previously emitted `ClearFormula` only — the
    /// value-clear half was invisible to the op log). Both halves are
    /// durable + replay-reproducible.
    #[test]
    fn set_value_blank_over_formula_emits_clear_value_and_clear_formula() {
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
        assert_eq!(ops.len(), 1, "ops were: {ops:?}");
        match &ops[0] {
            Op::BatchCommit { ops: inner } => {
                assert_eq!(inner.len(), 2, "inner ops: {inner:?}");
                assert!(matches!(inner[0], Op::ClearValue { .. }));
                assert!(matches!(inner[1], Op::ClearFormula { .. }));
            }
            other => panic!("expected BatchCommit{{ClearValue, ClearFormula}}, got {other:?}"),
        }
    }

    /// **F2 Blank-durability closure (2026-05-27):** the end-to-end
    /// durability guarantee. `set_value(A1, 5)` then `set_value(A1,
    /// Blank)` produces an op log which, replayed into a FRESH workbook,
    /// yields A1 == Blank (NOT the stale 5). Pre-F2 this replayed back to
    /// 5 because the Blank-clear emitted no op.
    #[test]
    fn set_value_then_blank_replays_to_blank_not_stale_value() {
        use ql_oplog::replay_into;
        let mut producer_wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
            rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
            rt.set_value(0, 0, 0, Value::Blank).unwrap();
        }
        // Live producer state: A1 is Blank.
        assert_eq!(
            producer_wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Blank
        );

        // Replay the log into a fresh workbook with the same shape.
        let mut replay_wb = make_runtime_workbook();
        replay_into(&oplog, &mut replay_wb, &reg).unwrap();
        assert_eq!(
            replay_wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Blank,
            "ClearValue must reproduce the value-clear on replay (not leave the stale 5)"
        );
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

    // (Tier D1 Step 3.6: Tier C1 cycle-detection tests moved.)

    // (Tier D1 Step 3.6: Phase 2B.2 RecomputeResult contract tests moved.)

    // (Tier D1 Step 3.6: Phase 2B.3 bind-plan cache tests moved.)

    // (Tier D1 Step 3.6: Phase 2B.4 named-range aggregate prep tests moved.)

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

    // (Tier D1 Step 3.6: Phase 3.1 calcgraph runtime integration tests moved.)

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

    // NOTE: as of W2-literal-range (2026-06-09), `SUM(Sheet2!A1:A3)`
    // (a literal cross-sheet range as a function arg) now BINDS — the
    // binder lowers `Expr::RangeRef` in `BindContext::AggregateArg` to
    // `ExprPlan::RangeRef { range }` (sheet resolved via
    // `resolve_range_ref_to_range` → `resolve_sheet_ref`). Pinned by
    // `w2_literal_range_cross_sheet_full_path` in `validate.rs`.
    // Cross-sheet ranges through named ranges also work; verified by the
    // named-target tests below.

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

    // (Tier D1 Step 3.4: W5-92 + W5-93 name/sheet test clusters
    //  moved to names.rs / sheets.rs sibling submodules.)

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

    // (Tier D1 Step 3.5: W5-116 structured-ref tests moved
    //  to tables.rs::tests.)

    // (Tier D1 Step 3.5: W5-118 create/drop tests moved
    //  to tables.rs::tests.)

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

    // (drop_table_removes_metadata_and_emits_op +
    // drop_table_missing_errors moved to tables.rs::tests per
    // Phase 5 V1 D1.a cluster 4 re-partitioning — drop_table impl
    // lives in tables.rs.)

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

    // (Tier D1 Step 3.5: W5-119 rename_table tests moved
    //  to tables.rs::tests.)

    // (Tier D1 Step 3.5: W5-121 rename_column tests moved
    //  to tables.rs::tests.)

    // (Tier D1 Step 3.5: W5-122 resize_table tests moved
    //  to tables.rs::tests.)

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

    // -------------------------------------------------------------
    // W5-147 (Phase 4.9.K) — set_formula canonical-storage tests.
    // Phase 5 V1 D1.a re-partitioning (2026-05-19): moved from
    // tables.rs::tests to cells.rs::tests (set_formula's impl lives
    // in cells.rs).
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
}
