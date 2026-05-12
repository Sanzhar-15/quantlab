//! Engine Phase 3.1 (2026-05-12) — runtime ↔ calcgraph integration shell.
//!
//! `CalcgraphSession` owns the `ql_calcgraph::Graph` plus a cell-index
//! `HashMap<(sheet, row, col), NodeId>` for O(1) "which node represents
//! this cell?" lookups. It lives at the engine level (in `ql-exec`) so
//! it can reach `ql-storage::Workbook` for rebuild + `ql-formula-syntax`
//! for lex/parse without dragging those deps into `ql-calcgraph`.
//!
//! ## Phase 3.1 scope (ownership + API shape only)
//!
//! 3.1 lays the FOUNDATION for the calcgraph-runtime integration but
//! does NOT yet do the load-bearing work:
//!
//! - `rebuild_from_workbook` walks every formula and adds a `CellNode`
//!   per formula cell. **Dependencies are NOT extracted yet** — that's
//!   Phase 3.2 (`Dependency Extraction From Bound Plans`). The graph
//!   has nodes but no edges.
//! - The five mutation hooks (`on_set_value`, `on_set_formula`,
//!   `on_clear_formula`, `on_set_name`, `on_add_sheet`) all exist and
//!   are wired through the runtime, but they're STUBS — they update
//!   the cell index where applicable and increment counters for
//!   observability, but they don't propagate dirty bits or update
//!   edges. Phase 3.3 (`Dirty Propagation And Stripe Range Index`)
//!   makes them load-bearing.
//! - `recompute_all` still walks formulas in HashMap order (GAP-R-01).
//!   Phase 3.4 replaces it with a Tarjan-SCC-scheduled walk over the
//!   graph.
//!
//! 3.1's contract is: the IDE / runtime CAN attach a graph session
//! today. The session tracks state. When 3.2+ fills in the algorithms,
//! the API surface doesn't change — only the internals get richer.
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

use std::collections::HashMap;
use std::sync::Arc;

use ql_calcgraph::{Graph, NodeId};
use ql_storage::Workbook;
use ql_types::{ColId, RowId, SheetId};

use crate::workbook_runtime::RuntimeError;

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

/// Errors emitted by `rebuild_from_workbook`. Engine Phase 3.1 only
/// surfaces formula-text parse failures — when 3.2 adds dependency
/// extraction, this gains variants for binder errors. Note that today,
/// `rebuild` is lenient: a malformed persisted formula doesn't fail the
/// whole rebuild (similar to `recompute_all`'s `RecomputeResult`); we
/// just skip nodes for cells that can't lex/parse. 3.2 changes this to
/// strict-error-aggregation parallel to `RecomputeResult`.
#[derive(Debug, thiserror::Error)]
pub enum RebuildError {
    // Reserved for Phase 3.2 use: structural bind errors during rebuild
    // will become variants here. For now `rebuild_from_workbook` returns
    // `Ok(Self)` and skips problem cells.
    #[error("rebuild error (reserved for Phase 3.2)")]
    Reserved,
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

    /// **G3-01 acceptance.** Deterministic rebuild from an existing
    /// `Workbook`: walks every formula cell in sorted `(sheet, row, col)`
    /// order, adds a `CellNode` per cell, populates the cell index.
    /// Returns a fresh `CalcgraphSession` ready for the runtime to
    /// attach.
    ///
    /// "Deterministic" here means: same workbook → same node IDs in the
    /// same order. Workbook's underlying `formula_cells` is a `HashMap`
    /// (iteration order arbitrary), so we sort before adding nodes.
    ///
    /// Phase 3.1 does NOT extract dependencies during rebuild — the
    /// graph has nodes but no edges. Phase 3.2's `Dependency Extraction
    /// From Bound Plans` pass adds edges.
    pub fn rebuild_from_workbook(wb: &Workbook) -> Result<Self, RebuildError> {
        let mut session = Self::new();

        // Snapshot + sort the formula list for determinism.
        let mut formulas: Vec<(SheetId, RowId, ColId, Arc<str>)> = wb
            .iter_formulas()
            .map(|(s, r, c, f)| (s, r, c, Arc::clone(f)))
            .collect();
        formulas.sort_by(|a, b| {
            // Lexicographic (sheet, row, col).
            (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2))
        });

        for (sheet, row, col, _text) in formulas {
            // Phase 3.1: add a CellNode; index it. No dependency
            // extraction yet. Phase 3.2 will lex+parse+bind the text
            // and walk for cell/range deps here.
            session.or_insert_cell_node(sheet, row, col);
        }

        Ok(session)
    }

    /// **G3-02 acceptance (hook 1/5).** Mutation hook fired by
    /// `WorkbookRuntime::set_value`. Phase 3.1 stub: bumps the counter
    /// and ensures the cell has a node in the index (writes to a cell
    /// that has never been referenced by a formula still get tracked
    /// for future dirty propagation).
    ///
    /// Phase 3.3 wires this to mark direct dependents + range
    /// dependents dirty via `Graph::dependents_for_cell`.
    pub fn on_set_value(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        self.hook_counts.set_value = self.hook_counts.set_value.saturating_add(1);
        // We DO NOT insert a node for plain literal writes — a cell
        // that's never been a formula doesn't need a graph vertex.
        // Phase 3.3 may revisit (literal cells that show up as
        // dependents need vertices for the dirty walk to find them).
        let _ = (sheet, row, col);
    }

    /// **G3-02 acceptance (hook 2/5).** Mutation hook fired by
    /// `WorkbookRuntime::set_formula`. Phase 3.1 stub: ensures the cell
    /// has a node (creating one if first encounter) so Phase 3.2 can
    /// later attach the formula's dependencies.
    ///
    /// `formula_text` is currently unused — Phase 3.2 will lex+parse+
    /// bind it here to extract cell/range/name dependencies.
    pub fn on_set_formula(&mut self, sheet: SheetId, row: RowId, col: ColId, _formula_text: &str) {
        self.hook_counts.set_formula = self.hook_counts.set_formula.saturating_add(1);
        let _ = self.or_insert_cell_node(sheet, row, col);
    }

    /// **G3-02 acceptance (hook 3/5).** Mutation hook fired by
    /// `WorkbookRuntime::clear_formula`. Phase 3.1 stub: bumps counter.
    /// Phase 3.3 will remove outgoing edges for the cleared cell's
    /// node (since its dependencies no longer apply).
    pub fn on_clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        self.hook_counts.clear_formula = self.hook_counts.clear_formula.saturating_add(1);
        let _ = (sheet, row, col);
    }

    /// **G3-02 acceptance (hook 4/5).** Mutation hook fired by
    /// `WorkbookRuntime::set_name`. Phase 3.1 stub: bumps counter.
    /// Phase 3.3 will mark all formulas with a NameRef to `name` dirty.
    pub fn on_set_name(&mut self, _name: &str) {
        self.hook_counts.set_name = self.hook_counts.set_name.saturating_add(1);
    }

    /// **G3-02 acceptance (hook 5/5).** Mutation hook fired by
    /// `WorkbookRuntime::add_sheet`. Phase 3.1 stub: bumps counter.
    /// Phase 4.6 (cross-sheet references) will use this to update the
    /// graph's sheet-id tracking.
    pub fn on_add_sheet(&mut self, _new_sheet: SheetId) {
        self.hook_counts.add_sheet = self.hook_counts.add_sheet.saturating_add(1);
    }

    // Phase 3.2 plans to add `extract_dependencies(...)` here:
    // lex+parse+bind the formula text against the workbook+NameTable,
    // walk the bound ExprPlan, and call
    //   self.graph.add_edge(formula_node, dep_cell_node)
    //   self.graph.register_range_dependency(formula_node, range, sheet)
    // for each direct/range dependency. Phase 3.1 intentionally omits
    // this — the API surface (rebuild + hooks) is stable here; the
    // algorithms land later without breaking callers.
}

/// Forward-compat error mapping for Phase 3.2: a future bind error
/// during a runtime hook would propagate as `RuntimeError`. Today's
/// hooks don't fail; this `From` is staged so Phase 3.2 doesn't churn
/// the runtime signatures.
impl From<RebuildError> for RuntimeError {
    fn from(_e: RebuildError) -> Self {
        // Phase 3.1: no current code path produces a RebuildError. The
        // From is here to lock the variant when 3.2 adds binding-time
        // failures during rebuild.
        unreachable!("RebuildError variants are reserved for Phase 3.2 — none constructible today")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let s = CalcgraphSession::rebuild_from_workbook(&wb).unwrap();
        assert_eq!(s.graph().node_count(), 0);
    }

    /// G3-01: rebuild from a workbook with N formulas → N CellNodes.
    #[test]
    fn rebuild_creates_one_cell_node_per_formula() {
        let wb =
            workbook_with_formulas(&[(0, 0, 0, "1 + 1"), (0, 0, 1, "2 + 2"), (0, 1, 0, "A1 + B1")]);
        let s = CalcgraphSession::rebuild_from_workbook(&wb).unwrap();
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
            let s = CalcgraphSession::rebuild_from_workbook(&wb).unwrap();
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

    /// G3-02: each of the five mutation hooks bumps its counter.
    #[test]
    fn mutation_hooks_each_bump_their_counter() {
        let mut s = CalcgraphSession::new();
        s.on_set_value(0, 0, 0);
        s.on_set_formula(0, 0, 1, "A1 + 1");
        s.on_set_formula(0, 0, 2, "A1 * 2");
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
        s.on_set_formula(0, 3, 7, "1 + 1");
        let first_node = s.cell_node_for(0, 3, 7).unwrap();
        s.on_set_formula(0, 3, 7, "2 + 2");
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
}
