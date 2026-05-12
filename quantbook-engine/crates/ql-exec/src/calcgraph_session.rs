//! Engine Phase 3.1+3.2 (2026-05-12) — runtime ↔ calcgraph integration.
//!
//! `CalcgraphSession` owns the `ql_calcgraph::Graph` plus per-formula
//! dependency tracking (cells / ranges / volatile / names). It lives
//! at the engine level (in `ql-exec`) so it can reach
//! `ql-storage::Workbook` for rebuild + `ql-formula-syntax` for
//! lex/parse without dragging those deps into `ql-calcgraph`.
//!
//! ## Phase 3.1 (ownership shell, shipped W5-34)
//!
//! - Single-writer ownership: runtime borrows `&mut CalcgraphSession`
//!   per edit (parallel to `&mut OpLog`).
//! - O(1) `cell_index: HashMap<(SheetId, RowId, ColId), NodeId>` for
//!   "which node represents this cell?" lookups.
//! - 5 hooks (`on_set_{value,formula,name}`, `on_clear_formula`,
//!   `on_add_sheet`) wired through `WorkbookRuntime`.
//! - `rebuild_from_workbook` adds a `CellNode` per formula cell in
//!   deterministic `(sheet, row, col)` sort order.
//!
//! ## Phase 3.2 (this commit) — dependency extraction
//!
//! - `walk_plan_for_deps` recursively walks a bound `ExprPlan`,
//!   producing a `FormulaDeps` collection of (a) direct cell refs,
//!   (b) named-range refs (from `AggregateNameRef`), (c) names
//!   referenced (currently only via `AggregateNameRef`; see below),
//!   (d) volatile-function presence.
//! - `on_set_formula` now takes `&ExprPlan` and runs the extraction.
//!   The session updates per-formula `formula_deps`, the volatile
//!   set, and a name→formulas reverse index.
//! - `rebuild_from_workbook` lex+parse+binds every formula and runs
//!   the same extraction. Failures aggregate into
//!   `RebuildResult { attempted, succeeded, failures }` — parallel
//!   to `RecomputeResult` (Phase 2B.2). The session is still returned
//!   on partial failure so the caller can inspect.
//! - Dependency storage is **session-side**, not in the `Graph`. The
//!   Phase 0 `Graph` edges are append-only; tracking the live deps on
//!   the session lets Phase 3.3 implement re-registration cleanly
//!   without needing edge removal (Phase 3.3 may swap in
//!   Formualizer-style delta-edges for the graph too).
//!
//! ## Still deferred to Phase 3.3+
//!
//! - **Dirty propagation.** The 5 mutation hooks bump counters and
//!   maintain dep state but don't yet fan out via
//!   `Graph::dependents_for_cell`. Phase 3.3 wires that.
//! - **Topological recompute.** `recompute_all` still HashMap-order
//!   (GAP-R-01). Phase 3.4 replaces with Tarjan SCC.
//! - **Name-dep tracking from non-AggregateNameRef paths.** When a
//!   `NameRef` resolves to a Cell/Number/Bool/Text target, the binder
//!   substitutes the underlying value and the name is lost. Today
//!   such names invalidate via the PlanCache's `name_gen` counter
//!   (Phase 2B.3) — a workbook-wide invalidation, not per-name.
//!   Phase 3.3 may switch to per-name dirty propagation; until then
//!   the PlanCache covers correctness.
//!
//! ## Ownership model
//!
//! ```text
//!  IDE / caller
//!    │
//!    ├─ owns Workbook                      (storage)
//!    ├─ owns OpLog                         (history; optional)
//!    ├─ owns CalcgraphSession              (graph; optional, new in 3.1)
//!    └─ owns FunctionRegistry              (process-wide singleton-ish)
//!         │
//!         └─ constructs WorkbookRuntime per edit (per-edit borrow window)
//! ```
//!
//! Phase 6.1 `WorkbookSession` will absorb Workbook + OpLog +
//! CalcgraphSession + PlanCache + FunctionRegistry into ONE owning
//! struct that the binding crate can wrap cleanly (per GAP-PS-09).
//! Today they're separate to keep refactor scope bounded.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ql_calcgraph::{schedule, CellNode, Graph, Node, NodeId, Schedule};
use ql_formula_syntax::{lex, parse, RangeRef};
use ql_storage::Workbook;
use ql_types::{ColId, Range, RowId, SheetId};

use crate::aggregate_cache::{AggregateCacheStats, InMemAggregateCache};
use crate::plan::{bind_with_names, ExprPlan};
use crate::workbook_runtime::RuntimeError;

/// Phase 3.3 (2026-05-12) — convert a `ql_types::Range` (used in
/// `ExprPlan::AggregateNameRef`) to a `ql_formula_syntax::RangeRef`
/// (used by `Graph::register_range_dependency`). The conversion picks
/// the most precise variant available so the stripe index stays
/// efficient:
///
/// - `start_row == 0 && end_row == RowId::MAX` → `WholeColumn` (one
///   stripe per column in the range).
/// - `start_col == 0 && end_col == ColId::MAX` → `WholeRow` (one
///   stripe per row).
/// - Otherwise → `Cells` (StripeIndex picks the smaller axis).
///
/// The Phase 0 `StripeIndex::register` panics on reversed bounds; this
/// helper trusts `Range` to be normalized (per `Range::new` which
/// sorts via `min/max`).
fn range_to_rangeref(r: Range) -> RangeRef {
    let whole_rows = r.start_row == 0 && r.end_row == RowId::MAX;
    let whole_cols = r.start_col == 0 && r.end_col == ColId::MAX;
    if whole_rows && !whole_cols {
        RangeRef::WholeColumn {
            sheet: Some(r.sheet),
            start_col: r.start_col,
            end_col: r.end_col,
            abs_start: false,
            abs_end: false,
        }
    } else if whole_cols && !whole_rows {
        RangeRef::WholeRow {
            sheet: Some(r.sheet),
            start_row: r.start_row,
            end_row: r.end_row,
            abs_start: false,
            abs_end: false,
        }
    } else {
        // Bounded rectangle (or fully-saturated rectangle, which the
        // stripe index handles by picking the smaller axis).
        RangeRef::Cells {
            sheet: Some(r.sheet),
            start_col: r.start_col,
            start_row: r.start_row,
            end_col: r.end_col,
            end_row: r.end_row,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        }
    }
}

/// Phase 3.2 (2026-05-12) — hardcoded list of functions whose RESULT
/// depends on something other than their arguments (NOW changes every
/// recompute even with no inputs; INDIRECT reads a cell named by a
/// string at runtime). The Phase 3.7 volatile-invalidation pass will
/// use this set to schedule volatile re-evaluation. Tracked here as
/// V0; Engine Phase 4.3 (function library expansion) replaces with
/// per-function metadata on `FunctionRegistry`.
///
/// Names MUST be canonical upper-case (matches the parser's
/// canonicalization for `Expr::Function::name`).
pub(crate) fn is_volatile_function(name: &str) -> bool {
    matches!(
        name,
        // Time / date — value changes every recompute.
        "NOW" | "TODAY"
        // Pseudo-random — value changes every recompute.
        | "RAND" | "RANDBETWEEN" | "RANDARRAY"
        // Address-by-string — result depends on workbook structure;
        // a cell rename anywhere can affect the result.
        | "INDIRECT"
        // Structural offset — result depends on the current grid.
        | "OFFSET"
        // Environment introspection.
        | "INFO" | "CELL"
    )
}

/// Phase 3.2 — direct-dep collection extracted from walking a bound
/// `ExprPlan`. Fields are owned (no borrows) so the caller can pass
/// the collection around or store it without lifetime ceremony.
///
/// `cells`, `named_ranges`, and `names` are deduplicated by the
/// `extract_and_register_deps` orchestrator (the walker emits
/// duplicates; the orchestrator collapses).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FormulaDeps {
    /// Direct cell references (`ExprPlan::CellRef`). Resolved sheet
    /// is included.
    pub cells: Vec<(SheetId, RowId, ColId)>,
    /// Named-range references (`ExprPlan::AggregateNameRef`). Each
    /// entry pairs the canonical (uppercase) name with the resolved
    /// `Range` payload.
    pub named_ranges: Vec<(Arc<str>, Range)>,
    /// Names referenced by the formula. Currently only names that
    /// resolve to ranges populate this (via `AggregateNameRef`); see
    /// module docs for the limitation around scalar-resolved names.
    pub names: Vec<Arc<str>>,
    /// `true` iff any volatile function appears anywhere in the
    /// plan tree.
    pub is_volatile: bool,
}

impl FormulaDeps {
    /// Total dependency count (cells + named ranges). Useful for
    /// summary metrics; Phase 3.10 megaudit / ql-profile will surface
    /// per-formula dep counts in the graph-profile JSON.
    pub fn len(&self) -> usize {
        self.cells.len() + self.named_ranges.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty() && self.named_ranges.is_empty()
    }
}

/// Phase 3.2 — recursive walker. Accumulates dependencies + volatile-
/// function presence by descending the `ExprPlan` tree. Does not
/// allocate any nodes or touch any graph state; pure read.
pub(crate) fn walk_plan_for_deps(plan: &ExprPlan, deps: &mut FormulaDeps) {
    match plan {
        ExprPlan::Number(_) | ExprPlan::Bool(_) | ExprPlan::String(_) => {
            // Leaf literals carry no dependencies.
        }
        ExprPlan::CellRef {
            sheet, row, col, ..
        } => {
            deps.cells.push((*sheet, *row, *col));
        }
        ExprPlan::Binary { lhs, rhs, .. } => {
            walk_plan_for_deps(lhs, deps);
            walk_plan_for_deps(rhs, deps);
        }
        ExprPlan::Unary { operand, .. } => {
            walk_plan_for_deps(operand, deps);
        }
        ExprPlan::Function { name, args } => {
            if is_volatile_function(name) {
                deps.is_volatile = true;
            }
            for arg in args {
                walk_plan_for_deps(arg, deps);
            }
        }
        ExprPlan::AggregateNameRef { name, range } => {
            deps.named_ranges.push((Arc::clone(name), *range));
            deps.names.push(Arc::clone(name));
        }
    }
}

/// Phase 3.1 runtime ↔ calcgraph integration container. Owns the
/// `Graph` plus an O(1) cell index. Construct via `new()` for empty,
/// or `rebuild_from_workbook` to build from an existing workbook's
/// formulas.
///
/// Single-writer ownership: the runtime borrows `&mut CalcgraphSession`
/// for the lifetime of one edit (same pattern as `&mut OpLog`).
#[derive(Debug, Default)]
pub struct CalcgraphSession {
    graph: Graph,
    /// O(1) lookup from a cell address to its `NodeId`. The Phase 0
    /// `Graph` itself doesn't carry this index — it's a runtime-side
    /// concern (the bench / structural tests don't need it). 3.1 puts
    /// it here so the runtime hooks can answer "do I already have a
    /// node for this cell?" without scanning.
    cell_index: HashMap<(SheetId, RowId, ColId), NodeId>,
    /// Phase 3.2: per-formula live dependency view. Keyed by the
    /// formula cell's `NodeId`; replaced wholesale on re-bind so
    /// stale entries can't leak (the Phase 0 graph's edges are
    /// append-only; this side-table sidesteps that until Phase 3.3
    /// brings delta-edge storage in).
    formula_deps: HashMap<NodeId, FormulaDeps>,
    /// Phase 3.2: formulas marked volatile by `walk_plan_for_deps`.
    /// Phase 3.7 (volatile invalidation) will read this set every
    /// recompute cycle to schedule re-evaluation regardless of
    /// upstream dependency state.
    volatile_formulas: HashSet<NodeId>,
    /// Phase 3.2: reverse index from canonical name → formulas that
    /// reference it. Today populated only by `AggregateNameRef` (the
    /// only plan variant that preserves the name after binding). Used
    /// in Phase 3.3 to mark formulas dirty when a named range
    /// changes.
    name_to_formulas: HashMap<Arc<str>, HashSet<NodeId>>,
    /// Phase 3.3 (2026-05-12): reverse index from a cell address to
    /// the formula node-ids that hold a DIRECT cell reference to it
    /// (i.e. `ExprPlan::CellRef`). Range-dep candidates go through
    /// `graph.dependents_for_cell` (stripe + precision); direct cell
    /// deps live here so re-binding a formula can drop stale entries
    /// cleanly without needing edge removal on the append-only Phase 0
    /// `Graph`. Symmetric to `name_to_formulas` for the named-dep path.
    cell_to_formulas: HashMap<(SheetId, RowId, ColId), HashSet<NodeId>>,
    /// Phase 3.3: set of formula nodes that need to be recomputed.
    /// Populated by the 5 mutation hooks via stripe + reverse-index
    /// fanout; consumed by `take_dirty` (the future Phase 3.4 Tarjan
    /// SCC scheduler will iterate this set in topological order).
    /// Per-recompute-cycle scoped — the caller clears the set after
    /// recompute.
    dirty: HashSet<NodeId>,
    /// Phase 3.6 (W5-39, 2026-05-12) — AGG-3-01..04 cache. Stores
    /// per-`(range, function_name)` aggregate results so a recompute
    /// that didn't touch any cell inside the range returns the cached
    /// value without re-scanning. `mark_dirty_from_cell_write`
    /// invalidates entries whose range contains the written cell
    /// (matching the stripe-precision-check pattern at the read side).
    aggregate_cache: InMemAggregateCache,
    /// Cumulative observability counters. Phase 3.1 records hook
    /// invocations for verification and future ql-profile integration.
    hook_counts: HookCounts,
}

/// Cumulative counts of each mutation hook invocation, since session
/// construction. Phase 3.1 ships this for testability + ql-profile
/// observability (Phase 3.10 megaudit will wire it into the
/// graph-profile JSON).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HookCounts {
    pub set_value: u64,
    pub set_formula: u64,
    pub clear_formula: u64,
    pub set_name: u64,
    pub add_sheet: u64,
}

/// Phase 3.2: aggregate outcome of `rebuild_from_workbook`. Parallel
/// to `RecomputeResult` from Phase 2B.2 — failures are aggregated
/// per-cell rather than short-circuiting, so the caller gets a
/// session containing as much as could be built plus a list of
/// formulas that couldn't be processed.
///
/// `attempted` and `succeeded` are workbook-formula counts; `failures`
/// lists each formula that couldn't lex/parse/bind, carrying its
/// position and the underlying `RuntimeError`. The returned
/// `CalcgraphSession` is usable; cells whose formulas failed simply
/// have a CellNode but no extracted dependencies.
#[derive(Debug)]
pub struct RebuildResult {
    pub session: CalcgraphSession,
    pub attempted: usize,
    pub succeeded: usize,
    pub failures: Vec<RebuildFailure>,
}

/// Single-formula failure during rebuild. Captures everything the
/// IDE needs to display a per-cell diagnostic without re-walking the
/// workbook.
#[derive(Debug)]
pub struct RebuildFailure {
    pub sheet: SheetId,
    pub row: RowId,
    pub col: ColId,
    pub formula_text: Arc<str>,
    pub error: RuntimeError,
}

impl RebuildResult {
    pub fn is_complete(&self) -> bool {
        self.failures.is_empty()
    }
    pub fn failed_count(&self) -> usize {
        self.failures.len()
    }
}

impl CalcgraphSession {
    /// Empty session: empty graph, empty cell index, zero counts.
    pub fn new() -> Self {
        Self::default()
    }

    /// Borrow the underlying `Graph` (read-only). Used by tests and by
    /// the eventual `ql-profile` graph-profile export.
    pub fn graph(&self) -> &Graph {
        &self.graph
    }

    /// `NodeId` representing the cell at `(sheet, row, col)`, if any.
    /// `None` if the cell has never been touched by the runtime nor
    /// added by rebuild.
    pub fn cell_node_for(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<NodeId> {
        self.cell_index.get(&(sheet, row, col)).copied()
    }

    /// Get the existing `NodeId` for this cell, or create a new
    /// `CellNode` and return its id. The cell index is updated in
    /// either case.
    fn or_insert_cell_node(&mut self, sheet: SheetId, row: RowId, col: ColId) -> NodeId {
        if let Some(id) = self.cell_index.get(&(sheet, row, col)) {
            return *id;
        }
        let id = self.graph.add_cell_node(sheet, row, col);
        self.cell_index.insert((sheet, row, col), id);
        id
    }

    /// Cumulative hook-invocation counters. Phase 3.1 uses these for
    /// observability and tests; Phase 3.10 megaudit wires them into
    /// `ql_profile::Timings` alongside `bind_plan_cache_*` and
    /// `fingerprint_cache_*`.
    pub fn hook_counts(&self) -> HookCounts {
        self.hook_counts
    }

    /// Phase 3.2: live dependency view for a formula cell. `None` if
    /// the cell has no formula or hasn't been bound yet (rebuild
    /// failed to lex/parse, or the cell isn't a formula at all).
    pub fn formula_deps(&self, node: NodeId) -> Option<&FormulaDeps> {
        self.formula_deps.get(&node)
    }

    /// Phase 3.2: is this formula's plan marked volatile? Volatile
    /// formulas are scheduled for re-evaluation on every recompute
    /// cycle in Phase 3.7.
    pub fn is_volatile(&self, node: NodeId) -> bool {
        self.volatile_formulas.contains(&node)
    }

    /// Phase 3.2: read-only view of the volatile-formula set. Phase
    /// 3.7 reads this every recompute cycle.
    pub fn volatile_formulas(&self) -> &HashSet<NodeId> {
        &self.volatile_formulas
    }

    /// Phase 3.2: formulas that reference `name` (canonical
    /// uppercase). Today populated only from `AggregateNameRef`
    /// occurrences. Phase 3.3 reads this from `on_set_name` to mark
    /// dependents dirty.
    pub fn formulas_referencing_name(&self, name: &str) -> Option<&HashSet<NodeId>> {
        let upper = name.to_ascii_uppercase();
        self.name_to_formulas.get(upper.as_str())
    }

    /// Phase 3.2 orchestrator + Phase 3.3 graph registration: walk a
    /// bound `ExprPlan`, populate the session's per-formula dep view +
    /// volatile set + name→formulas reverse index + cell→formulas
    /// reverse index (Phase 3.3) + the Graph's stripe-index ranges
    /// (Phase 3.3). Replaces any prior entry for the same formula
    /// node wholesale so re-bind cleanly drops stale session-side
    /// deps even though the Phase 0 graph's edges are append-only.
    ///
    /// Stripe-side stale entries DO accumulate on re-bind (the Phase 0
    /// `Graph` is append-only) — `Graph::dependents_for_cell` filters
    /// these via the formula_to_range_deps precision check, so the
    /// false-positive cost is read-side, not write-side. Phase 3.3
    /// accepts this trade-off (the Phase 0 graph contract); a future
    /// phase may add delta-edges to the graph.
    ///
    /// Internal — public callers go through `on_set_formula` or
    /// rebuild. `formula_node` MUST already exist in the graph (call
    /// `or_insert_cell_node` first if necessary). `formula_sheet` is
    /// the owning sheet of the formula cell; it's the fallback the
    /// `StripeIndex` uses when a range's own `sheet` is `None` (today
    /// every named-range conversion sets `Some(_)` so the fallback is
    /// inert, but the parameter is part of the stable graph API).
    fn extract_and_register_deps(
        &mut self,
        formula_node: NodeId,
        formula_sheet: SheetId,
        plan: &ExprPlan,
    ) {
        // First, evict any prior deps for this formula. Required so
        // re-binding a formula whose text changed (e.g. `=A1` → `=B1`)
        // doesn't leave the old cell-dep stamped on the session.
        self.remove_formula_deps(formula_node);

        // Walk and collect.
        let mut deps = FormulaDeps::default();
        walk_plan_for_deps(plan, &mut deps);

        // Register: deduplicate (the walker emits duplicates if the
        // formula references the same cell twice; the session stores
        // each cell once).
        let mut seen_cells: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
        deps.cells.retain(|c| seen_cells.insert(*c));
        let mut seen_names: HashSet<Arc<str>> = HashSet::new();
        deps.names.retain(|n| seen_names.insert(Arc::clone(n)));
        // named_ranges may contain the same name twice — that's
        // legitimate (`SUM(Sales) + AVERAGE(Sales)` references the
        // same range from two arg positions) — leave as-is.

        // Phase 3.3: register direct cell deps on the session-side
        // reverse index. We do NOT create CellNodes for dep cells (no
        // need — the lookup at `on_set_value` is by (sheet, row, col)
        // tuple, not by NodeId).
        //
        // Phase 3.4: ALSO add a forward `graph.add_edge(formula_node,
        // dep_node)` when the dep cell is ITSELF a formula cell. The
        // Tarjan scheduler walks `graph.outgoing(formula_node)` to
        // discover the dep set; without this edge it can't order a
        // chain like `=A1`, `=B1=A1+1`, `=C1=B1+1` correctly. The
        // edge is append-only per Phase 0 contract (re-bind leaves
        // stale edges — filed as GAP-G-01; impact is performance,
        // not correctness, because stale edges only add constraints).
        for &(s, r, c) in &deps.cells {
            self.cell_to_formulas
                .entry((s, r, c))
                .or_default()
                .insert(formula_node);
            if let Some(&dep_node) = self.cell_index.get(&(s, r, c)) {
                // Note: self-edges (formula_node == dep_node) are
                // ALLOWED here — they're the canonical way to model
                // `=A1` at A1 (self-cycle), and the Phase 0 W3-3
                // Tarjan scheduler treats a self-looped single-node
                // SCC as `cycled`.
                self.graph.add_edge(formula_node, dep_node);
            }
        }
        // Phase 3.3: register named-range deps with the Graph's stripe
        // index. The Graph's `register_range_dependency` populates BOTH
        // the stripe map AND the `formula_to_range_deps` precision-check
        // map atomically. We pass the formula's owning sheet as the
        // fallback (today every conversion sets `range.sheet =
        // Some(_)`, so the fallback is unused).
        for (_, range) in &deps.named_ranges {
            let range_ref = range_to_rangeref(*range);
            self.graph
                .register_range_dependency(formula_node, range_ref, formula_sheet);
        }

        if deps.is_volatile {
            self.volatile_formulas.insert(formula_node);
        }
        for name in &deps.names {
            self.name_to_formulas
                .entry(Arc::clone(name))
                .or_default()
                .insert(formula_node);
        }
        if !deps.is_empty() || deps.is_volatile {
            self.formula_deps.insert(formula_node, deps);
        }
    }

    /// Internal: remove all session-side dep state for `formula_node`.
    /// Used when a formula is re-bound (different text → different
    /// deps) or cleared. Cleans `formula_deps`, the volatile set, the
    /// name→formulas reverse index, and the cell→formulas reverse
    /// index. Does NOT touch the Phase 0 `Graph`'s stripe state or
    /// edges (append-only contract).
    fn remove_formula_deps(&mut self, formula_node: NodeId) {
        if let Some(prior) = self.formula_deps.remove(&formula_node) {
            for name in &prior.names {
                if let Some(set) = self.name_to_formulas.get_mut(name) {
                    set.remove(&formula_node);
                    if set.is_empty() {
                        self.name_to_formulas.remove(name);
                    }
                }
            }
            for cell in &prior.cells {
                if let Some(set) = self.cell_to_formulas.get_mut(cell) {
                    set.remove(&formula_node);
                    if set.is_empty() {
                        self.cell_to_formulas.remove(cell);
                    }
                }
            }
        }
        self.volatile_formulas.remove(&formula_node);
    }

    /// **G3-01 acceptance.** Deterministic rebuild from an existing
    /// `Workbook`. Walks every formula cell in sorted `(sheet, row, col)`
    /// order, adds a `CellNode` per cell, populates the cell index,
    /// and (Phase 3.2) lex+parse+binds each formula to extract
    /// dependencies.
    ///
    /// Determinism: same workbook → same node IDs in the same order.
    /// Workbook's underlying `formula_cells` is a `HashMap` (arbitrary
    /// iteration order), so we sort before adding nodes.
    ///
    /// Failures aggregate into [`RebuildResult::failures`] rather than
    /// short-circuiting — the returned session is usable, just with
    /// some formulas missing dep info. Matches Phase 2B.2's
    /// `RecomputeResult` shape.
    pub fn rebuild_from_workbook(wb: &Workbook) -> RebuildResult {
        let mut session = Self::new();

        // Snapshot + sort the formula list for determinism.
        let mut formulas: Vec<(SheetId, RowId, ColId, Arc<str>)> = wb
            .iter_formulas()
            .map(|(s, r, c, f)| (s, r, c, Arc::clone(f)))
            .collect();
        formulas.sort_by_key(|a| (a.0, a.1, a.2));

        let attempted = formulas.len();
        let mut succeeded = 0;
        let mut failures: Vec<RebuildFailure> = Vec::new();

        // Phase 3.4: pre-pass — insert a CellNode for every formula
        // before any extract runs. The Tarjan-side forward edges
        // require `cell_index` to be COMPLETE at extract time so
        // formula `=A1` at C1 can see A1's node and add the edge
        // (otherwise late-arriving deps would be missed). Done in
        // sorted order so node IDs stay deterministic.
        for (sheet, row, col, _) in &formulas {
            session.or_insert_cell_node(*sheet, *row, *col);
        }

        for (sheet, row, col, text) in formulas {
            let node = session
                .cell_node_for(sheet, row, col)
                .expect("pre-pass inserted every formula's node");

            // Phase 3.2: lex + parse + bind + extract deps. Failure
            // accumulates; we keep going. Phase 3.3 passes the
            // formula's owning sheet so the stripe register can use
            // the correct fallback for any range with `sheet: None`.
            match Self::bind_text(&text, sheet, wb) {
                Ok(plan) => {
                    session.extract_and_register_deps(node, sheet, &plan);
                    succeeded += 1;
                }
                Err(error) => failures.push(RebuildFailure {
                    sheet,
                    row,
                    col,
                    formula_text: text,
                    error,
                }),
            }
        }
        // Phase 3.3: a fresh rebuild starts with NO dirty formulas —
        // the caller has presumably already evaluated every cell into
        // the workbook (e.g. `load_workbook_and_recompute`), so the
        // session is in a clean state.
        session.dirty.clear();
        // Phase 3.6: aggregate cache also starts empty. Even if the
        // caller pre-populated the workbook with computed values, those
        // values aren't keyed by `(range, function)` and don't unlock
        // a cache hit on next eval. `clear_all` is a no-op on a fresh
        // session (the Default impl initializes empty), but keeping
        // it makes the contract explicit.
        session.aggregate_cache.clear_all();

        RebuildResult {
            session,
            attempted,
            succeeded,
            failures,
        }
    }

    /// Internal: lex + parse + bind a formula text against the
    /// workbook's NameTable. Used by `rebuild_from_workbook` and by
    /// `on_set_formula`'s text-only fallback. Phase 3.3 may add a
    /// cached version that integrates with `PlanCache`.
    fn bind_text(
        text: &str,
        owning_sheet: SheetId,
        wb: &Workbook,
    ) -> Result<ExprPlan, RuntimeError> {
        let tokens = lex(text)?;
        let expr = parse(tokens)?;
        Ok(bind_with_names(&expr, owning_sheet, wb.names())?)
    }

    /// **G3-02 acceptance (hook 1/5).** Mutation hook fired by
    /// `WorkbookRuntime::set_value`. Phase 3.3 (2026-05-12): the hook
    /// now marks every formula that depends on `(sheet, row, col)`
    /// dirty via two parallel paths:
    ///
    /// 1. Range deps via `Graph::dependents_for_cell` — stripe lookup
    ///    + precision check (DIR-3-02 acceptance).
    /// 2. Direct cell deps via the session-side `cell_to_formulas`
    ///    reverse index (formulas that hold an `ExprPlan::CellRef` to
    ///    this address).
    ///
    /// The hook DOES NOT create a node for the written cell: nodes
    /// exist for FORMULA cells only; dep lookups for plain literal
    /// cells go through the (sheet, row, col) tuple in both indices.
    pub fn on_set_value(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        self.hook_counts.set_value = self.hook_counts.set_value.saturating_add(1);
        self.mark_dirty_from_cell_write(sheet, row, col);
    }

    /// **G3-02 acceptance (hook 2/5).** Mutation hook fired by
    /// `WorkbookRuntime::set_formula`. Ensures the cell has a node,
    /// walks the bound plan to register cell + range + name + volatile
    /// dependencies (Phase 3.2), AND propagates dirty to downstream
    /// formulas (Phase 3.3) — set_formula at a cell that other
    /// formulas already reference means those downstream formulas now
    /// see a different value and must recompute.
    ///
    /// The runtime passes the already-bound `ExprPlan` it just
    /// evaluated; this hook does NOT re-bind. The plan shape is stable
    /// since 2B.4 (Phase 3.2 doesn't add new variants).
    pub fn on_set_formula(&mut self, sheet: SheetId, row: RowId, col: ColId, plan: &ExprPlan) {
        self.hook_counts.set_formula = self.hook_counts.set_formula.saturating_add(1);
        // Phase 3.4: distinguish first-time-formula at this cell vs
        // re-bind. The first case needs RETROACTIVE forward edges
        // from previously-existing formulas that already reference
        // this cell (those formulas' extract didn't see a NodeId for
        // this cell at the time, so no edge was added).
        let is_new_formula = self.cell_node_for(sheet, row, col).is_none();
        let node = self.or_insert_cell_node(sheet, row, col);
        if is_new_formula {
            let referencing: Vec<NodeId> = self
                .cell_to_formulas
                .get(&(sheet, row, col))
                .map(|s| s.iter().copied().collect())
                .unwrap_or_default();
            for prev in referencing {
                if prev != node {
                    self.graph.add_edge(prev, node);
                }
            }
        }
        self.extract_and_register_deps(node, sheet, plan);
        // Phase 3.3: dirty downstream — formulas referencing the cell
        // whose formula text just changed see a (potentially) new
        // value. The formula itself is NOT marked dirty (the runtime
        // wrote a fresh value for it before invoking this hook).
        self.mark_dirty_from_cell_write(sheet, row, col);
    }

    /// **G3-02 acceptance (hook 3/5).** Mutation hook fired by
    /// `WorkbookRuntime::clear_formula`. Phase 3.2: drops the cell's
    /// session-side dep state (formula_deps, volatile, name reverse
    /// index, cell reverse index). Phase 3.3: also marks downstream
    /// formulas dirty (the cleared formula no longer produces its
    /// prior value; dependents must recompute) and removes the
    /// cleared formula itself from the dirty set.
    pub fn on_clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        self.hook_counts.clear_formula = self.hook_counts.clear_formula.saturating_add(1);
        if let Some(node) = self.cell_index.get(&(sheet, row, col)).copied() {
            self.remove_formula_deps(node);
            // The cleared formula doesn't compute anymore. If it was
            // dirty (queued for recompute), drop it from the set.
            self.dirty.remove(&node);
        }
        // Downstream formulas see this cell change — propagate dirty.
        self.mark_dirty_from_cell_write(sheet, row, col);
    }

    /// **G3-02 acceptance (hook 4/5).** Mutation hook fired by
    /// `WorkbookRuntime::set_name`. Phase 3.3 (2026-05-12): marks all
    /// formulas referencing `name` (per `name_to_formulas`) dirty.
    /// Today this reverse index is populated only by
    /// `ExprPlan::AggregateNameRef` — see GAP-R-07 for the scalar-
    /// NameRef precision gap (PlanCache `name_gen` still covers
    /// correctness; per-name precision is the open follow-up).
    pub fn on_set_name(&mut self, name: &str) {
        self.hook_counts.set_name = self.hook_counts.set_name.saturating_add(1);
        // Case-insensitive lookup matches `formulas_referencing_name`
        // canonicalization (NameTable + the dep walker both store
        // uppercase). Snapshot the set into a local Vec to avoid a
        // double-mut borrow on `self`.
        let upper = name.to_ascii_uppercase();
        let dependents: Vec<NodeId> = self
            .name_to_formulas
            .get(upper.as_str())
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default();
        for n in dependents {
            self.dirty.insert(n);
        }
    }

    /// **G3-02 acceptance (hook 5/5).** Mutation hook fired by
    /// `WorkbookRuntime::add_sheet`. Phase 3.1 stub still: bumps
    /// counter. No dirty effect — a new sheet contains no formulas
    /// yet. Phase 4.6 (cross-sheet references) will use this to update
    /// the graph's sheet-id tracking.
    pub fn on_add_sheet(&mut self, _new_sheet: SheetId) {
        self.hook_counts.add_sheet = self.hook_counts.add_sheet.saturating_add(1);
    }

    /// Phase 3.3 (single-hop) + Phase 3.4 (BFS): internal fanout —
    /// for a write at `(sheet, row, col)`, mark every formula node
    /// that TRANSITIVELY depends on this cell dirty. Two reverse-
    /// direction lookups per visited node:
    ///
    /// 1. `Graph::dependents_for_cell` returns range-dep candidates,
    ///    already filtered by the precision check (DIR-3-02).
    /// 2. `cell_to_formulas[(s,r,c)]` returns direct-cell-dep
    ///    formulas.
    ///
    /// Phase 3.4 added the BFS pass: for each newly-marked formula
    /// `F`, look up `F`'s cell address and recurse. A chain
    /// `=A1 → =B1=A1+1 → =C1=B1+1` thus marks both B1 AND C1 dirty
    /// from a single edit at A1. The `dirty.insert(node)` check
    /// returns false on duplicate insert → BFS visits each node at
    /// most once → cycles in the dep graph are safe.
    fn mark_dirty_from_cell_write(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        use std::collections::VecDeque;
        let mut queue: VecDeque<NodeId> = VecDeque::new();

        // Phase 3.6 (AGG-3-02): invalidate any cached aggregate whose
        // range contains this cell. Done BEFORE the dirty fanout so a
        // formula whose recompute would otherwise hit a stale cache
        // sees a fresh miss + recomputation. Precision is exact —
        // writes outside every cached range are O(cache_size) with no
        // entry removal.
        self.aggregate_cache.invalidate_at(sheet, row, col);

        // Seed with the direct fanout from the edited cell (which may
        // not itself be a formula).
        for dep in self.graph.dependents_for_cell(sheet, row, col) {
            if self.dirty.insert(dep) {
                queue.push_back(dep);
            }
        }
        if let Some(set) = self.cell_to_formulas.get(&(sheet, row, col)) {
            for &dep in set {
                if self.dirty.insert(dep) {
                    queue.push_back(dep);
                }
            }
        }

        // BFS: for every newly-marked formula, find what depends on
        // ITS cell and propagate. This is the transitive closure of
        // the reverse-dep relation, scoped to formula nodes.
        while let Some(node) = queue.pop_front() {
            let Some((ns, nr, nc)) = self.cell_address_for(node) else {
                continue;
            };
            for dep in self.graph.dependents_for_cell(ns, nr, nc) {
                if self.dirty.insert(dep) {
                    queue.push_back(dep);
                }
            }
            if let Some(set) = self.cell_to_formulas.get(&(ns, nr, nc)) {
                let snapshot: Vec<NodeId> = set.iter().copied().collect();
                for dep in snapshot {
                    if self.dirty.insert(dep) {
                        queue.push_back(dep);
                    }
                }
            }
        }
    }

    /// Phase 3.3: read-only view of the dirty set. Caller may iterate
    /// to schedule recompute. Use `take_dirty` to atomically claim +
    /// clear.
    pub fn dirty_formulas(&self) -> &HashSet<NodeId> {
        &self.dirty
    }

    /// Phase 3.3: is this formula currently queued for recompute?
    pub fn is_dirty(&self, node: NodeId) -> bool {
        self.dirty.contains(&node)
    }

    /// Phase 3.3: claim + clear the dirty set in one move. The Phase
    /// 3.4 Tarjan SCC scheduler will call this once per recompute
    /// cycle. Returning `HashSet<NodeId>` rather than a slice lets
    /// callers re-sort / topologically order without re-allocating.
    pub fn take_dirty(&mut self) -> HashSet<NodeId> {
        std::mem::take(&mut self.dirty)
    }

    /// Phase 3.6 — borrow the aggregate cache. The runtime passes this
    /// to `eval_scalar_with_cache` during `recompute_dirty` /
    /// `set_formula` so aggregate-over-range evals hit the cache when
    /// nothing in the range changed since the last computation.
    pub fn aggregate_cache(&self) -> &InMemAggregateCache {
        &self.aggregate_cache
    }

    /// Phase 3.6 — snapshot of `(hits, misses, invalidations)` for
    /// observability + tests (AGG-3-01 asserts hits > 0 after an
    /// unrelated edit; AGG-3-02 asserts invalidations > 0 after an
    /// intersecting edit).
    pub fn aggregate_cache_stats(&self) -> AggregateCacheStats {
        self.aggregate_cache.stats()
    }

    /// Phase 3.3 introspection: how many cells have at least one
    /// formula referencing them via a direct `ExprPlan::CellRef`?
    /// Used by tests + future ql-profile observability. Range deps
    /// live on the Graph's stripe index — query
    /// `graph().stripe_index()` for those.
    pub fn cell_dep_count(&self) -> usize {
        self.cell_to_formulas.len()
    }

    /// Phase 3.4: address lookup for a formula node. The graph's
    /// `Node::Cell` payload carries `(sheet, row, col)` — this is the
    /// inverse of `cell_node_for`. Returns `None` if the node is not
    /// a Cell variant (today every NodeId in `cell_index` is a Cell;
    /// Phase 4 may add Range/Region nodes that aren't formula cells).
    pub fn cell_address_for(&self, node: NodeId) -> Option<(SheetId, RowId, ColId)> {
        match self.graph.node(node) {
            Node::Cell(CellNode { sheet, row, col }) => Some((*sheet, *row, *col)),
            _ => None,
        }
    }

    /// **Phase 3.4 acceptance (SCH-3-01..04 entry point).** Atomically
    /// claim the dirty set and run the Phase 0 W3-3 iterative Tarjan
    /// scheduler over it. The returned [`Schedule`] partitions nodes:
    ///
    /// - `sorted`: dependency-first topological order. Evaluate
    ///   `sorted[0]` before `sorted[1]`, etc.
    /// - `cycled`: nodes in a non-trivial strongly connected component
    ///   (size > 1) or with a self-loop. Per Phase 0 spec these get
    ///   `Value::Error(ErrorValue::Circ)`.
    ///
    /// The dirty set is cleared by this call. Edges to non-dirty
    /// nodes are not traversed (those nodes aren't being recomputed;
    /// their current values are read as-is). Input ordering is
    /// sorted-by-NodeId before the scheduler runs so SCH-3-03
    /// determinism holds: same workbook + same edits → same schedule
    /// across runs (the underlying scheduler is already deterministic
    /// in its input slice order; we just normalize HashSet iteration).
    pub fn schedule_dirty(&mut self) -> Schedule {
        let mut dirty_vec: Vec<NodeId> = self.dirty.drain().collect();
        dirty_vec.sort();
        schedule(&self.graph, &dirty_vec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::BindError;
    use ql_types::Value;

    fn workbook_with_formulas(formulas: &[(SheetId, RowId, ColId, &str)]) -> Workbook {
        let mut wb = Workbook::new();
        // Ensure enough sheets exist.
        let max_sheet = formulas.iter().map(|(s, _, _, _)| *s).max().unwrap_or(0);
        for i in 0..=max_sheet {
            wb.add_sheet(format!("S{i}"));
        }
        for (sheet, row, col, text) in formulas {
            wb.put_at(*sheet, *row, *col, Value::Blank);
            wb.put_formula(*sheet, *row, *col, *text);
        }
        wb
    }

    #[test]
    fn empty_session_has_zero_nodes_and_zero_counts() {
        let s = CalcgraphSession::new();
        assert_eq!(s.graph().node_count(), 0);
        assert_eq!(s.hook_counts(), HookCounts::default());
    }

    /// G3-01: rebuild from an empty workbook → empty session.
    #[test]
    fn rebuild_from_empty_workbook_is_empty() {
        let wb = Workbook::new();
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        assert_eq!(r.attempted, 0);
        assert_eq!(r.session.graph().node_count(), 0);
    }

    /// G3-01: rebuild from a workbook with N formulas → N CellNodes.
    #[test]
    fn rebuild_creates_one_cell_node_per_formula() {
        let wb =
            workbook_with_formulas(&[(0, 0, 0, "1 + 1"), (0, 0, 1, "2 + 2"), (0, 1, 0, "A1 + B1")]);
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete(), "all three formulas should bind");
        assert_eq!(r.succeeded, 3);
        let s = r.session;
        assert_eq!(s.graph().node_count(), 3);
        // Every formula cell has an indexed node.
        assert!(s.cell_node_for(0, 0, 0).is_some());
        assert!(s.cell_node_for(0, 0, 1).is_some());
        assert!(s.cell_node_for(0, 1, 0).is_some());
        // Non-formula cells do not.
        assert!(s.cell_node_for(0, 5, 5).is_none());
    }

    /// G3-01: deterministic rebuild — same workbook → same node IDs in
    /// the same order across runs. Without sorting, Workbook's HashMap
    /// iteration order would give different `NodeId`s on different
    /// runs.
    #[test]
    fn rebuild_is_deterministic_across_runs() {
        let wb = workbook_with_formulas(&[
            (0, 7, 7, "100"),
            (0, 0, 0, "1 + 1"),
            (1, 3, 2, "A1 + 1"),
            (0, 5, 5, "5 + 5"),
        ]);
        let mut prior_ids: Option<Vec<NodeId>> = None;
        for _ in 0..10 {
            let r = CalcgraphSession::rebuild_from_workbook(&wb);
            assert!(r.is_complete());
            let s = r.session;
            // Collect node ids in sheet/row/col-sorted order.
            let mut ids: Vec<((SheetId, RowId, ColId), NodeId)> =
                s.cell_index.iter().map(|(k, v)| (*k, *v)).collect();
            ids.sort_by_key(|(k, _)| *k);
            let just_ids: Vec<NodeId> = ids.iter().map(|(_, id)| *id).collect();
            if let Some(prev) = prior_ids.as_ref() {
                assert_eq!(*prev, just_ids, "rebuild produced different node IDs");
            }
            prior_ids = Some(just_ids);
        }
    }

    /// G3-02: each of the five mutation hooks bumps its counter. Phase
    /// 3.2 changed `on_set_formula` to take `&ExprPlan`; this test
    /// passes a trivial literal plan since it only cares about counter
    /// increments.
    #[test]
    fn mutation_hooks_each_bump_their_counter() {
        let mut s = CalcgraphSession::new();
        let plan = ExprPlan::Number(1.0);
        s.on_set_value(0, 0, 0);
        s.on_set_formula(0, 0, 1, &plan);
        s.on_set_formula(0, 0, 2, &plan);
        s.on_clear_formula(0, 0, 1);
        s.on_set_name("Tax");
        s.on_set_name("Discount");
        s.on_add_sheet(1);

        let counts = s.hook_counts();
        assert_eq!(counts.set_value, 1);
        assert_eq!(counts.set_formula, 2);
        assert_eq!(counts.clear_formula, 1);
        assert_eq!(counts.set_name, 2);
        assert_eq!(counts.add_sheet, 1);
    }

    /// `on_set_formula` ensures the cell has a node; calling it twice
    /// on the same cell does NOT create a duplicate node.
    #[test]
    fn on_set_formula_is_idempotent_for_cell_node_creation() {
        let mut s = CalcgraphSession::new();
        let plan = ExprPlan::Number(0.0);
        s.on_set_formula(0, 3, 7, &plan);
        let first_node = s.cell_node_for(0, 3, 7).unwrap();
        s.on_set_formula(0, 3, 7, &plan);
        let second_node = s.cell_node_for(0, 3, 7).unwrap();
        assert_eq!(
            first_node, second_node,
            "second on_set_formula must reuse the same node"
        );
        assert_eq!(s.graph().node_count(), 1);
    }

    /// G3-03 (compile-time / structural): ql-calcgraph is verified to
    /// keep petgraph off the hot path — the `Graph` is hand-rolled
    /// adjacency vectors per the Round 7 T1-D02 architectural lock.
    /// This test is a smoke check that we use only the `Graph` /
    /// `NodeId` API, not anything petgraph-derived. Phase 3.1 does
    /// nothing to compromise this — we only add a HashMap index, no
    /// graph library is pulled in.
    #[test]
    fn graph_construction_uses_no_petgraph_types() {
        let mut s = CalcgraphSession::new();
        let id = s.or_insert_cell_node(0, 0, 0);
        // NodeId is `pub struct NodeId(u32)` from ql-calcgraph (the
        // hand-rolled type), not a petgraph::NodeIndex.
        let _: NodeId = id;
        // `Graph::node_count`, `revision`, etc. are all on the
        // hand-rolled Graph type. If a future commit replaces the
        // backing with petgraph, this test still passes by name but
        // the cargo audit / multiversion clones check would surface
        // the dep change. Treat this as documentation more than
        // enforcement.
        assert_eq!(s.graph().node_count(), 1);
    }

    // ----------------------------------------------------------------
    // Phase 3.2 acceptance gates (DEP-3-01..04).
    //
    // These exercise the new `walk_plan_for_deps` + dep registration
    // machinery via the public `rebuild_from_workbook` /
    // `formula_deps` / `is_volatile` / `formulas_referencing_name` API.
    // The Phase 3.7 dirty-propagation work will lean on every field
    // populated here.
    // ----------------------------------------------------------------

    /// DEP-3-01: direct cell references in a formula land in
    /// `FormulaDeps::cells` exactly once each, even when the formula
    /// references the same cell twice.
    #[test]
    fn dep_3_01_direct_cell_refs_captured() {
        // `A1 + B1 + A1` references A1 twice and B1 once. The walker
        // emits A1 twice; the orchestrator dedupes to one entry.
        let wb = workbook_with_formulas(&[(0, 1, 0, "A1 + B1 + A1")]);
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete(), "formula should bind cleanly");
        let s = r.session;
        let node = s.cell_node_for(0, 1, 0).unwrap();
        let deps = s.formula_deps(node).expect("dep view present");
        assert_eq!(deps.cells.len(), 2, "A1 and B1 — deduped, A1 appears once");
        assert!(deps.cells.contains(&(0, 0, 0)), "A1 captured");
        assert!(deps.cells.contains(&(0, 0, 1)), "B1 captured");
        assert!(deps.named_ranges.is_empty());
        assert!(!deps.is_volatile);
    }

    /// DEP-3-02: a SUM-over-named-range stays as one `named_range`
    /// entry — it does NOT explode into N cell deps. This is the
    /// HyperFormula-style range-as-single-edge optimization that lets
    /// the calcgraph stay tractable on big sheets.
    #[test]
    fn dep_3_02_range_deps_remain_compressed() {
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        // Seed a contiguous numeric block.
        for r in 0..10u32 {
            wb.put_at(0, r, 0, Value::Number(r as f64));
        }
        // Define a name pointing at that block.
        wb.set_name(
            "Block",
            ql_storage::NamedTarget::Range(Range {
                sheet: 0,
                start_row: 0,
                end_row: 9,
                start_col: 0,
                end_col: 0,
            }),
        )
        .unwrap();
        // Formula that uses the name in aggregate context.
        wb.put_at(0, 0, 5, Value::Blank);
        wb.put_formula(0, 0, 5, "SUM(Block)");

        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete(), "SUM(Block) must bind");
        let s = r.session;
        let node = s.cell_node_for(0, 0, 5).unwrap();
        let deps = s.formula_deps(node).expect("dep view present");
        assert!(
            deps.cells.is_empty(),
            "named range must not expand to per-cell deps"
        );
        assert_eq!(
            deps.named_ranges.len(),
            1,
            "one entry per named range reference"
        );
        let (name, range) = &deps.named_ranges[0];
        assert_eq!(name.as_ref(), "BLOCK", "name canonicalized to uppercase");
        assert_eq!(range.end_row, 9, "range payload preserved");
    }

    /// DEP-3-03: the name→formulas reverse index is populated whenever
    /// a formula references a name (today: only via AggregateNameRef).
    /// Phase 3.3 reads this to mark dependents dirty when the name's
    /// target changes.
    #[test]
    fn dep_3_03_named_deps_captured() {
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        for r in 0..5u32 {
            wb.put_at(0, r, 0, Value::Number(r as f64));
        }
        wb.set_name(
            "Sales",
            ql_storage::NamedTarget::Range(Range {
                sheet: 0,
                start_row: 0,
                end_row: 4,
                start_col: 0,
                end_col: 0,
            }),
        )
        .unwrap();
        wb.put_at(0, 0, 5, Value::Blank);
        wb.put_at(0, 1, 5, Value::Blank);
        wb.put_formula(0, 0, 5, "SUM(Sales)");
        wb.put_formula(0, 1, 5, "AVERAGE(Sales) + SUM(Sales)");

        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        let s = r.session;

        let n_sum = s.cell_node_for(0, 0, 5).unwrap();
        let n_avg = s.cell_node_for(0, 1, 5).unwrap();

        let referencing = s
            .formulas_referencing_name("Sales")
            .expect("reverse index populated");
        assert_eq!(referencing.len(), 2, "both formulas reverse-indexed");
        assert!(referencing.contains(&n_sum));
        assert!(referencing.contains(&n_avg));

        // Lookup is case-insensitive (matches NameTable canonicalization).
        assert!(s.formulas_referencing_name("SALES").is_some());
        assert!(s.formulas_referencing_name("sales").is_some());
        assert!(
            s.formulas_referencing_name("Unknown").is_none(),
            "unknown name returns None"
        );
    }

    /// DEP-3-04: volatile functions land in the volatile set + bump
    /// `FormulaDeps::is_volatile`. Phase 3.7 reads this set every
    /// recompute cycle.
    #[test]
    fn dep_3_04_volatile_functions_marked() {
        let wb = workbook_with_formulas(&[
            (0, 0, 0, "NOW() + 1"),
            (0, 0, 1, "RAND() * 100"),
            (0, 0, 2, "A1 + B1"), // not volatile
        ]);
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete(), "all formulas should bind");
        let s = r.session;

        let n_now = s.cell_node_for(0, 0, 0).unwrap();
        let n_rand = s.cell_node_for(0, 0, 1).unwrap();
        let n_plain = s.cell_node_for(0, 0, 2).unwrap();

        assert!(s.is_volatile(n_now), "NOW() marks formula volatile");
        assert!(s.is_volatile(n_rand), "RAND() marks formula volatile");
        assert!(!s.is_volatile(n_plain), "plain arithmetic is not volatile");

        let vol = s.volatile_formulas();
        assert_eq!(vol.len(), 2);
        assert!(vol.contains(&n_now));
        assert!(vol.contains(&n_rand));

        // The per-formula dep view also carries the bit.
        assert!(s.formula_deps(n_now).unwrap().is_volatile);
        assert!(s.formula_deps(n_rand).unwrap().is_volatile);
    }

    /// Phase 3.2 invariant: re-binding a formula REPLACES its dep set
    /// wholesale — stale cell deps from the prior text don't linger.
    #[test]
    fn rebind_replaces_prior_deps() {
        use ql_formula_syntax::Operator;
        let mut s = CalcgraphSession::new();
        // First plan: =A1+B1 — two cells.
        let plan_v1 = ExprPlan::Binary {
            op: Operator::Plus,
            lhs: Box::new(ExprPlan::CellRef {
                sheet: 0,
                row: 0,
                col: 0,
                abs_col: false,
                abs_row: false,
            }),
            rhs: Box::new(ExprPlan::CellRef {
                sheet: 0,
                row: 0,
                col: 1,
                abs_col: false,
                abs_row: false,
            }),
        };
        s.on_set_formula(0, 5, 5, &plan_v1);
        let node = s.cell_node_for(0, 5, 5).unwrap();
        assert_eq!(s.formula_deps(node).unwrap().cells.len(), 2);

        // Second plan: =C1 — one cell. Prior A1/B1 must be evicted.
        let plan_v2 = ExprPlan::CellRef {
            sheet: 0,
            row: 0,
            col: 2,
            abs_col: false,
            abs_row: false,
        };
        s.on_set_formula(0, 5, 5, &plan_v2);
        let deps = s.formula_deps(node).unwrap();
        assert_eq!(deps.cells, vec![(0, 0, 2)]);
    }

    /// Phase 3.2: clearing a formula evicts its dep entry from
    /// `formula_deps`, the volatile set, and the name→formulas reverse
    /// index.
    #[test]
    fn clear_formula_evicts_dep_state() {
        // Note (Phase 3.2): names like `Foo`/`Pi` collide with the
        // parser's column-letter heuristic. Use a longer name.
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.set_name(
            "MyRange",
            ql_storage::NamedTarget::Range(Range {
                sheet: 0,
                start_row: 0,
                end_row: 0,
                start_col: 0,
                end_col: 0,
            }),
        )
        .unwrap();
        wb.put_at(0, 0, 5, Value::Blank);
        wb.put_formula(0, 0, 5, "SUM(MyRange) + NOW()");

        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete(), "{:?}", r.failures);
        let mut s = r.session;

        let node = s.cell_node_for(0, 0, 5).unwrap();
        assert!(s.formula_deps(node).is_some());
        assert!(s.is_volatile(node));
        assert!(s.formulas_referencing_name("MyRange").is_some());

        s.on_clear_formula(0, 0, 5);

        assert!(s.formula_deps(node).is_none(), "dep entry evicted");
        assert!(
            !s.is_volatile(node),
            "volatile bit dropped on clear_formula"
        );
        assert!(
            s.formulas_referencing_name("MyRange").is_none(),
            "name reverse-index dropped — last referencing formula gone"
        );
    }

    /// Phase 3.2: rebuild aggregates per-formula bind failures rather
    /// than short-circuiting. The session returned still has CellNodes
    /// for every formula cell (so the graph topology is complete),
    /// just no dep info for the failed ones.
    #[test]
    fn rebuild_aggregates_per_formula_failures() {
        let wb = workbook_with_formulas(&[
            (0, 0, 0, "1 + 1"),               // ok
            (0, 0, 1, "1 +"),                 // parse fail (trailing operator)
            (0, 0, 2, "SUM(MyUnknownName1)"), // bind fail (UnresolvedName)
        ]);
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert_eq!(r.attempted, 3);
        assert_eq!(r.succeeded, 1);
        assert_eq!(r.failed_count(), 2, "{:?}", r.failures);
        // Every formula cell still has a node (graph topology intact).
        assert_eq!(r.session.graph().node_count(), 3);
        // The good one has dep info; the failures do not.
        let n_ok = r.session.cell_node_for(0, 0, 0).unwrap();
        let n_bad1 = r.session.cell_node_for(0, 0, 1).unwrap();
        let n_bad2 = r.session.cell_node_for(0, 0, 2).unwrap();
        // `1 + 1` has no cell deps but the entry isn't allocated since
        // there's nothing to track — that's by design (we only allocate
        // FormulaDeps when there's at least one dep or a volatile bit).
        assert!(r.session.formula_deps(n_ok).is_none());
        assert!(r.session.formula_deps(n_bad1).is_none());
        assert!(r.session.formula_deps(n_bad2).is_none());

        // Failures carry full position + text + error class.
        let by_addr: HashMap<(SheetId, RowId, ColId), &RebuildFailure> = r
            .failures
            .iter()
            .map(|f| ((f.sheet, f.row, f.col), f))
            .collect();
        assert!(matches!(by_addr[&(0, 0, 1)].error, RuntimeError::Parse(_)));
        // (0, 0, 2) is either a Parse or Bind error depending on how the
        // parser tokenizes the trailing-digit identifier — assert it's
        // any structural failure (which is what `rebuild` aggregates).
        let bad2 = &by_addr[&(0, 0, 2)].error;
        assert!(
            matches!(
                bad2,
                RuntimeError::Bind(BindError::UnresolvedName(_))
                    | RuntimeError::Parse(_)
                    | RuntimeError::Lex(_)
            ),
            "unexpected error class for (0,0,2): {bad2:?}"
        );
    }

    /// `walk_plan_for_deps` is pure — calling it twice on the same
    /// plan with two fresh `FormulaDeps` produces equal collections.
    #[test]
    fn walk_plan_for_deps_is_pure() {
        use ql_formula_syntax::Operator;
        let plan = ExprPlan::Binary {
            op: Operator::Plus,
            lhs: Box::new(ExprPlan::CellRef {
                sheet: 0,
                row: 0,
                col: 0,
                abs_col: false,
                abs_row: false,
            }),
            rhs: Box::new(ExprPlan::Function {
                name: "NOW".into(),
                args: Vec::new(),
            }),
        };
        let mut a = FormulaDeps::default();
        let mut b = FormulaDeps::default();
        walk_plan_for_deps(&plan, &mut a);
        walk_plan_for_deps(&plan, &mut b);
        assert_eq!(a, b);
        assert!(a.is_volatile);
        assert_eq!(a.cells.len(), 1);
    }

    /// The hardcoded volatile set covers Excel-canon volatile
    /// functions and is upper-case canonical.
    #[test]
    fn volatile_function_set_is_canonical() {
        for f in [
            "NOW",
            "TODAY",
            "RAND",
            "RANDBETWEEN",
            "RANDARRAY",
            "INDIRECT",
            "OFFSET",
            "INFO",
            "CELL",
        ] {
            assert!(is_volatile_function(f), "{f} must be volatile");
        }
        // Lowercase / mixed are NOT recognized — the parser
        // canonicalizes function names to uppercase before binding, so
        // the set only ever sees uppercase.
        assert!(!is_volatile_function("now"));
        assert!(!is_volatile_function("Sum"));
        // Sanity: non-volatile arithmetic functions are not in the set.
        assert!(!is_volatile_function("SUM"));
        assert!(!is_volatile_function("AVERAGE"));
        assert!(!is_volatile_function("IF"));
    }

    // ----------------------------------------------------------------
    // Phase 3.3 acceptance gates (DIR-3-01..04).
    //
    // The Phase 0 `Graph::dependents_for_cell` already does stripe-
    // lookup + precision-check at the graph layer (W3-5). Phase 3.3
    // wires it: writes to a cell propagate dirty to the formulas that
    // depend on that cell (directly or via range), and re-bind cleans
    // session-side state cleanly.
    // ----------------------------------------------------------------

    /// Helper: build a workbook with a single named-range formula. The
    /// named range covers `MyRange` for rows in `range_rows`, and a
    /// SUM-over-`MyRange` formula sits at `formula_cell`.
    fn workbook_with_named_range_sum(
        range_start_row: RowId,
        range_end_row: RowId,
        formula_cell: (RowId, ColId),
    ) -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        wb.set_name(
            "MyRange",
            ql_storage::NamedTarget::Range(Range {
                sheet: 0,
                start_row: range_start_row,
                end_row: range_end_row,
                start_col: 0,
                end_col: 0,
            }),
        )
        .unwrap();
        wb.put_at(0, formula_cell.0, formula_cell.1, Value::Blank);
        wb.put_formula(0, formula_cell.0, formula_cell.1, "SUM(MyRange)");
        wb
    }

    /// DIR-3-01: a write to a cell INSIDE a formula's named-range
    /// dependency marks that formula dirty. The basic happy path —
    /// stripe lookup hits and the precision check passes.
    #[test]
    fn dir_3_01_write_inside_range_dirties_dependent() {
        // MyRange = A1:A1000; formula =SUM(MyRange) at B1.
        let wb = workbook_with_named_range_sum(0, 999, (0, 1));
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        let mut s = r.session;
        let formula_node = s.cell_node_for(0, 0, 1).unwrap();
        assert!(s.dirty_formulas().is_empty(), "rebuild leaves clean state");

        // Write to A500 — inside the range. Formula should dirty.
        s.on_set_value(0, 500, 0);
        assert!(s.is_dirty(formula_node), "SUM(MyRange) marked dirty");
        assert_eq!(s.dirty_formulas().len(), 1);

        // take_dirty atomically claims + clears.
        let taken = s.take_dirty();
        assert!(taken.contains(&formula_node));
        assert!(s.dirty_formulas().is_empty(), "take_dirty clears the set");
    }

    /// DIR-3-02: a write OUTSIDE a formula's range does NOT dirty,
    /// even though the stripe-level lookup would match (precision
    /// check filters the false positive). MyRange = A1:A10; write to
    /// A500 hits Column 0 stripe but A500 is not in [A1:A10].
    #[test]
    fn dir_3_02_write_outside_range_filtered_by_precision_check() {
        let wb = workbook_with_named_range_sum(0, 9, (0, 1));
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        let mut s = r.session;
        let formula_node = s.cell_node_for(0, 0, 1).unwrap();

        // Write to A500 — outside [A1:A10]. Stripe matches Column 0,
        // but precision check drops it.
        s.on_set_value(0, 500, 0);
        assert!(
            !s.is_dirty(formula_node),
            "A500 outside [A1:A10] must not dirty SUM(MyRange)"
        );
        assert!(s.dirty_formulas().is_empty());

        // Sanity: a write INSIDE [A1:A10] still works.
        s.on_set_value(0, 5, 0);
        assert!(s.is_dirty(formula_node));
    }

    /// DIR-3-03: whole-column, whole-row, and bounded named ranges all
    /// produce correct dirty propagation. We exercise all three via
    /// distinct named ranges and verify each fires on the right writes
    /// and stays silent on the wrong ones.
    ///
    /// Naming note: short names like "ColA" / "Row5" collide with the
    /// parser's column-letter / cell-ref heuristic. We use
    /// `WholeColumnA` / `WholeRowFive` / `BoundedRect` to force the
    /// NameRef path.
    #[test]
    fn dir_3_03_whole_col_whole_row_bounded_all_supported() {
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        // WholeColumn: A:A — `start_row=0, end_row=u32::MAX` sentinel
        // is the canonical "whole column" representation. (The Phase
        // 3.3 `range_to_rangeref` converter produces `RangeRef::
        // WholeColumn` for this shape; the stripe insertion is O(1)
        // in column count.)
        wb.set_name(
            "WholeColumnA",
            ql_storage::NamedTarget::Range(Range {
                sheet: 0,
                start_row: 0,
                end_row: RowId::MAX,
                start_col: 0,
                end_col: 0,
            }),
        )
        .unwrap();
        // WholeRow: 5:5
        wb.set_name(
            "WholeRowFive",
            ql_storage::NamedTarget::Range(Range {
                sheet: 0,
                start_row: 5,
                end_row: 5,
                start_col: 0,
                end_col: ColId::MAX,
            }),
        )
        .unwrap();
        // Bounded: C10:C20
        wb.set_name(
            "BoundedRect",
            ql_storage::NamedTarget::Range(Range {
                sheet: 0,
                start_row: 9,
                end_row: 19,
                start_col: 2,
                end_col: 2,
            }),
        )
        .unwrap();
        wb.put_at(0, 0, 10, Value::Blank);
        wb.put_at(0, 1, 10, Value::Blank);
        wb.put_at(0, 2, 10, Value::Blank);
        wb.put_formula(0, 0, 10, "SUM(WholeColumnA)");
        wb.put_formula(0, 1, 10, "SUM(WholeRowFive)");
        wb.put_formula(0, 2, 10, "SUM(BoundedRect)");

        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete(), "{:?}", r.failures);
        let mut s = r.session;
        let n_cola = s.cell_node_for(0, 0, 10).unwrap();
        let n_row5 = s.cell_node_for(0, 1, 10).unwrap();
        let n_bounded = s.cell_node_for(0, 2, 10).unwrap();

        // Sanity: 3 distinct stripes registered (Column 0, Row 5,
        // Column 2 — Bounded's height > width so it goes on column).
        assert_eq!(s.graph().stripe_index().stripe_count(), 3);

        // Write to A9999 — should hit WholeColumnA.
        s.on_set_value(0, 9999, 0);
        assert!(s.is_dirty(n_cola), "WholeColumnA: A9999 in whole column");
        assert!(!s.is_dirty(n_row5));
        assert!(!s.is_dirty(n_bounded));
        s.take_dirty();

        // Write to row 5, column 50 — should hit WholeRowFive.
        s.on_set_value(0, 5, 50);
        assert!(s.is_dirty(n_row5), "WholeRowFive: (5,50) in whole row");
        // WholeColumnA shouldn't fire — col=50, not col=0.
        assert!(!s.is_dirty(n_cola));
        assert!(!s.is_dirty(n_bounded));
        s.take_dirty();

        // Write to C15 — should hit BoundedRect (C10:C20).
        s.on_set_value(0, 15, 2);
        assert!(s.is_dirty(n_bounded), "BoundedRect: C15 inside C10:C20");
        assert!(!s.is_dirty(n_cola));
        assert!(!s.is_dirty(n_row5));
        s.take_dirty();

        // Write to (row=50, col=50) — outside ALL three ranges.
        // WholeColumnA wants col 0; WholeRowFive wants row 5;
        // BoundedRect wants col 2 within rows 9-19. None hit. The
        // dirty set must stay empty (no stripe candidates means no
        // precision check fires either).
        s.on_set_value(0, 50, 50);
        assert!(
            s.dirty_formulas().is_empty(),
            "(50,50) outside all three named ranges"
        );

        // Write to C25 — col 2 (BoundedRect's column), but row 25 is
        // BELOW BoundedRect's bottom edge (row 19). Stripe matches at
        // Col 2 but precision check drops it. DIR-3-02 reaffirmed for
        // the bounded case.
        s.on_set_value(0, 25, 2);
        assert!(
            s.dirty_formulas().is_empty(),
            "C25 below BoundedRect — precision check drops the stripe hit"
        );
    }

    /// DIR-3-04: registering a whole-column dependency MUST NOT create
    /// per-cell graph edges. A formula `=SUM(ColA)` over A:A registers
    /// ONE stripe entry, not 1M edges — that's the Formualizer-style
    /// compressed-range optimization. Verify by counting the stripe
    /// index size and the graph edge count.
    #[test]
    fn dir_3_04_no_per_cell_edge_explosion_for_full_columns() {
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        wb.set_name(
            "ColA",
            ql_storage::NamedTarget::Range(Range {
                sheet: 0,
                start_row: 0,
                end_row: RowId::MAX,
                start_col: 0,
                end_col: 0,
            }),
        )
        .unwrap();
        wb.put_at(0, 0, 1, Value::Blank);
        wb.put_formula(0, 0, 1, "SUM(ColA)");

        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        let s = r.session;

        // Exactly one stripe entry (Column 0 on Sheet 0).
        assert_eq!(
            s.graph().stripe_index().stripe_count(),
            1,
            "WholeColumn must register exactly one Column stripe"
        );
        // Zero per-cell edges — the formula's deps live on the stripe
        // map + formula_to_range_deps, not as Graph edges.
        assert_eq!(
            s.graph().edge_count(),
            0,
            "no per-cell edges for whole-column named range"
        );
        // The formula's range registration count is 1.
        assert_eq!(s.graph().range_dependency_count(), 1);
    }

    /// Direct cell-ref deps populate `cell_to_formulas`. A write to
    /// the referenced cell dirties the formula via the session-side
    /// reverse index (NOT via the stripe path).
    #[test]
    fn set_value_on_direct_cell_dep_dirties_formula() {
        // =A1 + B1 at C1.
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_at(0, 0, 1, Value::Number(2.0));
        wb.put_at(0, 0, 2, Value::Blank);
        wb.put_formula(0, 0, 2, "A1 + B1");

        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        let mut s = r.session;
        let c1 = s.cell_node_for(0, 0, 2).unwrap();
        assert_eq!(s.cell_dep_count(), 2, "A1 and B1 indexed");

        // Write to A1 — formula dirties.
        s.on_set_value(0, 0, 0);
        assert!(s.is_dirty(c1));
        s.take_dirty();

        // Write to D5 — unrelated cell, formula stays clean.
        s.on_set_value(0, 5, 3);
        assert!(s.dirty_formulas().is_empty());

        // Write to B1 — formula dirties (B1 is in deps too).
        s.on_set_value(0, 0, 1);
        assert!(s.is_dirty(c1));
    }

    /// `on_set_name` fans out via `name_to_formulas` (Phase 3.2
    /// reverse index from named-range deps). Every formula that
    /// references the name becomes dirty.
    #[test]
    fn set_name_dirties_all_referencing_formulas() {
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        wb.set_name(
            "Discount",
            ql_storage::NamedTarget::Range(Range {
                sheet: 0,
                start_row: 0,
                end_row: 9,
                start_col: 0,
                end_col: 0,
            }),
        )
        .unwrap();
        wb.put_at(0, 0, 5, Value::Blank);
        wb.put_at(0, 1, 5, Value::Blank);
        wb.put_at(0, 2, 5, Value::Blank);
        wb.put_formula(0, 0, 5, "SUM(Discount)");
        wb.put_formula(0, 1, 5, "AVERAGE(Discount)");
        // C3 doesn't reference Discount — should stay clean.
        wb.put_formula(0, 2, 5, "1 + 1");

        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        let mut s = r.session;
        let n_sum = s.cell_node_for(0, 0, 5).unwrap();
        let n_avg = s.cell_node_for(0, 1, 5).unwrap();
        let n_unrelated = s.cell_node_for(0, 2, 5).unwrap();

        s.on_set_name("discount"); // case-insensitive
        assert!(s.is_dirty(n_sum));
        assert!(s.is_dirty(n_avg));
        assert!(!s.is_dirty(n_unrelated), "unrelated formula not dirtied");
        assert_eq!(s.dirty_formulas().len(), 2);
    }

    /// `on_clear_formula` removes the cleared formula from the dirty
    /// set AND propagates dirty to its downstream dependents.
    #[test]
    fn clear_formula_evicts_self_and_dirties_downstream() {
        // C1 = A1 + B1; D1 = C1 + 1. Clearing C1 dirties D1 but not C1.
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_at(0, 0, 1, Value::Number(2.0));
        wb.put_at(0, 0, 2, Value::Blank);
        wb.put_at(0, 0, 3, Value::Blank);
        wb.put_formula(0, 0, 2, "A1 + B1");
        wb.put_formula(0, 0, 3, "C1 + 1");

        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        let mut s = r.session;
        let c1 = s.cell_node_for(0, 0, 2).unwrap();
        let d1 = s.cell_node_for(0, 0, 3).unwrap();

        // Pre-mark C1 dirty (simulating a prior pending recompute).
        s.dirty.insert(c1);
        s.dirty.insert(d1);

        s.on_clear_formula(0, 0, 2);
        // C1 evicted (it no longer computes).
        assert!(!s.is_dirty(c1));
        // D1 still in dirty (we re-marked it via mark_dirty_from_cell_write
        // since the C1 value changed).
        assert!(s.is_dirty(d1));
    }

    /// Phase 3.3 + Phase 3.2 interplay: re-binding a formula evicts
    /// stale cell deps from `cell_to_formulas`, so writes to old deps
    /// no longer fire dirty marks.
    #[test]
    fn rebind_clears_cell_reverse_index_for_old_deps() {
        let mut s = CalcgraphSession::new();
        // Plan v1: =A1 — depends on A1 only.
        let plan_v1 = ExprPlan::CellRef {
            sheet: 0,
            row: 0,
            col: 0,
            abs_col: false,
            abs_row: false,
        };
        s.on_set_formula(0, 5, 5, &plan_v1);
        let node = s.cell_node_for(0, 5, 5).unwrap();
        assert_eq!(s.cell_dep_count(), 1, "A1 indexed");

        // Plan v2: =B1 — depends on B1 only. A1 reverse-index entry
        // must be evicted by `remove_formula_deps`.
        let plan_v2 = ExprPlan::CellRef {
            sheet: 0,
            row: 0,
            col: 1,
            abs_col: false,
            abs_row: false,
        };
        s.on_set_formula(0, 5, 5, &plan_v2);
        assert_eq!(s.cell_dep_count(), 1, "only B1 now");

        // Take dirty (clear residue from the two on_set_formula calls).
        s.take_dirty();

        // Write to A1 — formula must NOT dirty (no longer a dep).
        s.on_set_value(0, 0, 0);
        assert!(
            !s.is_dirty(node),
            "stale A1 dep should not fire after re-bind"
        );

        // Write to B1 — fires.
        s.on_set_value(0, 0, 1);
        assert!(s.is_dirty(node));
    }

    /// Phase 3.3: rebuild leaves a clean dirty set (a fresh load
    /// means everything is computed; the caller fans out dirty via
    /// edits after rebuild). Tested elsewhere too but pinned here
    /// because it's a load-bearing invariant for the Phase 3.4
    /// scheduler.
    #[test]
    fn rebuild_from_workbook_starts_clean_no_dirty() {
        let wb = workbook_with_named_range_sum(0, 99, (0, 1));
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        assert!(r.session.dirty_formulas().is_empty());
    }

    /// `dependents_for_cell` returns a deterministic order; the Phase
    /// 3.3 `mark_dirty_from_cell_write` deduplicates via HashSet so
    /// order doesn't matter on the dirty side. But for the future
    /// Phase 3.4 SCC scheduler, downstream ordering matters — this
    /// test just pins that the graph keeps the contract from W3-5.
    #[test]
    fn graph_dependents_for_cell_remains_deterministic() {
        let wb = workbook_with_named_range_sum(0, 9, (0, 1));
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        let s = r.session;
        let deps1 = s.graph().dependents_for_cell(0, 5, 0);
        let deps2 = s.graph().dependents_for_cell(0, 5, 0);
        assert_eq!(deps1, deps2);
    }

    // ----------------------------------------------------------------
    // Phase 3.4 acceptance gates (SCH-3-01..04).
    //
    // The Phase 0 W3-3 iterative Tarjan scheduler already exists in
    // ql-calcgraph::topo. Phase 3.4 wires it: extract_and_register_deps
    // adds forward edges for direct cell→cell deps so Tarjan can
    // discover the dep graph; schedule_dirty consumes the session's
    // dirty set and returns (sorted, cycled).
    //
    // These tests live at the session level — they verify the
    // schedule's shape directly. The matching end-to-end recompute
    // tests live in `workbook_runtime.rs` (where the runtime evaluates
    // the schedule's `sorted` order and writes `#CIRC!` for the
    // `cycled` set).
    // ----------------------------------------------------------------

    /// Helper: workbook for the canonical dependency-chain test.
    /// A1 = 1 (literal); B1 = A1 + 1; C1 = B1 + 1.
    fn chain_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_at(0, 0, 1, Value::Blank);
        wb.put_at(0, 0, 2, Value::Blank);
        wb.put_formula(0, 0, 1, "A1 + 1");
        wb.put_formula(0, 0, 2, "B1 + 1");
        wb
    }

    /// SCH-3-01: dependency chains schedule in correct order. With
    /// A1=literal, B1=A1+1, C1=B1+1, marking A1 dirty propagates to
    /// B1 + C1 (via cell_to_formulas) and the schedule orders
    /// B1 BEFORE C1 (because C1 depends on B1).
    #[test]
    fn sch_3_01_dependency_chains_schedule_in_dependency_first_order() {
        let wb = chain_workbook();
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        let mut s = r.session;
        let b1 = s.cell_node_for(0, 0, 1).unwrap();
        let c1 = s.cell_node_for(0, 0, 2).unwrap();

        // Phase 3.4 invariant: the forward edge from C1 to B1 exists
        // in the graph (extract_and_register_deps added it on the
        // rebuild pre-pass + extract).
        assert!(
            s.graph().outgoing(c1).contains(&b1),
            "C1 must have an outgoing edge to B1 (the dep)"
        );

        // Edit A1 — both B1 and C1 dirty.
        s.on_set_value(0, 0, 0);
        assert!(s.is_dirty(b1));
        assert!(s.is_dirty(c1));

        let sched = s.schedule_dirty();
        assert!(sched.cycled.is_empty(), "no cycles in a linear chain");
        // B1 must come before C1 in sorted order.
        let pos_b1 = sched.sorted.iter().position(|n| *n == b1).unwrap();
        let pos_c1 = sched.sorted.iter().position(|n| *n == c1).unwrap();
        assert!(
            pos_b1 < pos_c1,
            "B1 must schedule before C1 (B1 is C1's dep)"
        );

        // dirty set is cleared after schedule_dirty.
        assert!(s.dirty_formulas().is_empty());
    }

    /// SCH-3-02: cycles surface in `Schedule::cycled` carrying every
    /// SCC member. Build a 2-cycle (A1 = B1 + 1; B1 = A1 + 1) and a
    /// self-loop (D1 = D1 + 1) and verify the cycle reporter sees
    /// every involved node.
    #[test]
    fn sch_3_02_cycles_report_all_scc_members() {
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        wb.put_at(0, 0, 0, Value::Blank);
        wb.put_at(0, 0, 1, Value::Blank);
        wb.put_at(0, 0, 3, Value::Blank);
        wb.put_formula(0, 0, 0, "B1 + 1");
        wb.put_formula(0, 0, 1, "A1 + 1");
        // Self-cycle at D1.
        wb.put_formula(0, 0, 3, "D1 + 1");

        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        let mut s = r.session;
        let a1 = s.cell_node_for(0, 0, 0).unwrap();
        let b1 = s.cell_node_for(0, 0, 1).unwrap();
        let d1 = s.cell_node_for(0, 0, 3).unwrap();

        // Force the cycle into dirty: edit any of A1/B1, the dirty
        // walk picks up the cycle members via direct-cell-dep reverse
        // index. We seed both formulas + the self-loop directly.
        s.dirty.insert(a1);
        s.dirty.insert(b1);
        s.dirty.insert(d1);

        let sched = s.schedule_dirty();
        assert!(
            sched.cycled.contains(&a1),
            "A1 must surface in cycled — part of the 2-cycle"
        );
        assert!(
            sched.cycled.contains(&b1),
            "B1 must surface in cycled — part of the 2-cycle"
        );
        assert!(
            sched.cycled.contains(&d1),
            "D1 must surface in cycled — self-loop"
        );
        // Sorted should be empty in this case (every dirty node is in
        // a cycle).
        assert!(sched.sorted.is_empty());
    }

    /// SCH-3-03: schedule is deterministic across runs. Two
    /// independent rebuilds of the same workbook + same edit sequence
    /// produce the same Schedule.
    #[test]
    fn sch_3_03_schedule_is_deterministic_across_runs() {
        fn run() -> (Vec<NodeId>, Vec<NodeId>) {
            let wb = chain_workbook();
            let r = CalcgraphSession::rebuild_from_workbook(&wb);
            let mut s = r.session;
            s.on_set_value(0, 0, 0); // edit A1
            let sched = s.schedule_dirty();
            (sched.sorted, sched.cycled)
        }
        let r1 = run();
        let r2 = run();
        assert_eq!(r1, r2, "schedule must be byte-identical across runs");
    }

    /// SCH-3-04: schedule operates ONLY on the dirty subset. An
    /// edit to A1 dirties B1 + C1 but does NOT include unrelated
    /// formula E1 (which references some other cell).
    #[test]
    fn sch_3_04_dirty_subset_avoids_unrelated_formulas() {
        let mut wb = Workbook::new();
        wb.add_sheet("S0");
        // A1=lit, B1=A1+1, C1=B1+1 — the chain.
        wb.put_at(0, 0, 0, Value::Number(1.0));
        wb.put_at(0, 0, 1, Value::Blank);
        wb.put_at(0, 0, 2, Value::Blank);
        wb.put_formula(0, 0, 1, "A1 + 1");
        wb.put_formula(0, 0, 2, "B1 + 1");
        // E1 = Z1 + 1 — unrelated to A1/B1/C1.
        wb.put_at(0, 0, 4, Value::Blank);
        wb.put_at(0, 0, 25, Value::Number(7.0));
        wb.put_formula(0, 0, 4, "Z1 + 1");

        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(r.is_complete());
        let mut s = r.session;
        let b1 = s.cell_node_for(0, 0, 1).unwrap();
        let c1 = s.cell_node_for(0, 0, 2).unwrap();
        let e1 = s.cell_node_for(0, 0, 4).unwrap();

        // Edit A1 only.
        s.on_set_value(0, 0, 0);
        let sched = s.schedule_dirty();
        let all: HashSet<NodeId> = sched
            .sorted
            .iter()
            .chain(sched.cycled.iter())
            .copied()
            .collect();
        assert!(all.contains(&b1));
        assert!(all.contains(&c1));
        assert!(
            !all.contains(&e1),
            "E1 must NOT appear in the schedule — it doesn't depend on A1"
        );
    }

    /// Phase 3.4 edge case: empty dirty set produces empty Schedule.
    #[test]
    fn schedule_dirty_with_empty_dirty_is_empty_schedule() {
        let mut s = CalcgraphSession::new();
        let sched = s.schedule_dirty();
        assert!(sched.is_empty());
        assert_eq!(sched.total_count(), 0);
    }

    /// Phase 3.4 invariant: `cell_address_for` is the inverse of
    /// `cell_node_for`. Round-trip every formula cell in a workbook
    /// and verify equality.
    #[test]
    fn cell_address_for_inverts_cell_node_for() {
        let wb = chain_workbook();
        let r = CalcgraphSession::rebuild_from_workbook(&wb);
        let s = r.session;
        for (sheet, row, col) in [(0u16, 0u32, 1u32), (0, 0, 2)] {
            let node = s.cell_node_for(sheet, row, col).unwrap();
            let addr = s.cell_address_for(node).unwrap();
            assert_eq!(addr, (sheet, row, col));
        }
    }

    /// Phase 3.4 retroactive-edge guarantee: setting a formula AT a
    /// cell that older formulas already reference must wire the
    /// forward edges so Tarjan can order them. Edit sequence:
    ///   1. B1 = A1 + 1   (added first; A1 not a formula yet → no
    ///      F'→F edge possible)
    ///   2. A1 = 99       (now A1 becomes a formula; the retroactive
    ///      path must add the B1→A1 edge)
    #[test]
    fn retroactive_edge_when_dep_becomes_formula() {
        use ql_formula_syntax::Operator;
        let mut s = CalcgraphSession::new();
        // B1 = A1 + 1.
        let plan_b1 = ExprPlan::Binary {
            op: Operator::Plus,
            lhs: Box::new(ExprPlan::CellRef {
                sheet: 0,
                row: 0,
                col: 0,
                abs_col: false,
                abs_row: false,
            }),
            rhs: Box::new(ExprPlan::Number(1.0)),
        };
        s.on_set_formula(0, 0, 1, &plan_b1);
        let b1 = s.cell_node_for(0, 0, 1).unwrap();
        // A1 isn't a formula yet.
        assert!(s.cell_node_for(0, 0, 0).is_none());
        // So B1's outgoing is empty — no edge to a non-existent A1
        // node.
        assert!(s.graph().outgoing(b1).is_empty());

        // Now set A1 = 99 — turns A1 into a formula. Retroactive
        // edge B1 → A1 must materialize.
        let plan_a1 = ExprPlan::Number(99.0);
        s.on_set_formula(0, 0, 0, &plan_a1);
        let a1 = s.cell_node_for(0, 0, 0).unwrap();
        assert!(
            s.graph().outgoing(b1).contains(&a1),
            "retroactive edge B1 → A1 must exist after A1 becomes a formula"
        );
    }
}
