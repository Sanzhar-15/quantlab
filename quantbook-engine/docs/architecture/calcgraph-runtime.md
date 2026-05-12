# Calcgraph ↔ runtime integration

**Status:** Engine Phase 3.4 SHIPPED (W5-37, 2026-05-12) — Tarjan SCC scheduler + `recompute_dirty` live  
**Date:** 2026-05-12 (last touched for 3.4 close-out)  
**Stability:** **STABLE** API surface; **3.5–3.10 will fill in the overlay / aggregate cache / volatile invalidation / etc.** but the 5-hook signature + `dirty_formulas` / `take_dirty` view + `schedule_dirty()` / `recompute_dirty()` entry points are the contract.

This document describes how `ql-calcgraph::Graph` integrates with `ql_exec::WorkbookRuntime`. Engine Phase 3 (the "One Engine" integration phase) closes the gap between the Phase 0 calcgraph (`ql-calcgraph`, built for the bench / A4/A5 acceptance) and the runtime that's been used since Phase 1 W5-10 (`WorkbookRuntime`, currently HashMap-order recompute with no graph awareness).

## 1. The ownership model

```text
  IDE / caller
    │
    ├─ owns Workbook                      (storage; ql-storage)
    ├─ owns OpLog                         (history; ql-oplog; optional)
    ├─ owns CalcgraphSession              (graph state; ql-exec; optional, NEW in 3.1)
    └─ owns FunctionRegistry              (dispatch; ql-functions)
         │
         └─ constructs WorkbookRuntime per edit (per-edit borrow window):
              ├─ &mut Workbook
              ├─ &FunctionRegistry
              ├─ Option<&mut OpLog>
              └─ Option<&mut CalcgraphSession>      ← NEW
```

`CalcgraphSession` is owned **alongside** the workbook (parallel to `OpLog`), not **inside** the workbook. The reason: `ql-storage::Workbook` is the storage primitive — it has no dependency on `ql-formula-syntax` or `ql-calcgraph`. The graph needs to lex/parse formula text to extract dependencies, which would invert the dep direction. By keeping the graph in `ql-exec` (where lex/parse + storage are both available), the dep graph stays acyclic.

Engine Phase 6.1 (`WorkbookSession`) absorbs `Workbook` + `OpLog` + `CalcgraphSession` + `PlanCache` + `FunctionRegistry` into ONE owning struct that the binding crate can wrap cleanly (per GAP-PS-09). Today these are separate to keep refactor scope bounded.

## 2. The two essential operations

### 2.1 Rebuild

```rust
let session = CalcgraphSession::rebuild_from_workbook(&workbook)?;
```

Used at workbook open. Walks every formula cell in the workbook in deterministic `(sheet, row, col)` sorted order, adds a `CellNode` per cell, populates an O(1) `cell_index`. **Phase 3.1 does NOT extract dependencies during rebuild** — the graph has nodes but no edges. Phase 3.2 (`Dependency Extraction From Bound Plans`) walks bound `ExprPlan`s and adds edges.

Determinism: same workbook → same node IDs in the same order across runs. Achieved by sorting before iteration (Workbook's underlying `formula_cells` is a `HashMap` with arbitrary iteration order).

Rebuild is **O(n)** in formula count today. When Phase 3.2 adds bind-pass + dep extraction, it becomes **O(n · cost(bind))** — still linear in the formula count, dominated by parse + bind work that the bind-plan cache (Phase 2B.3) already memoizes for subsequent rebuilds in the same session.

### 2.2 Mutation hooks

```rust
// In WorkbookRuntime, when an attached CalcgraphSession is present:
session.on_set_value(sheet, row, col);
session.on_set_formula(sheet, row, col, formula_text);
session.on_clear_formula(sheet, row, col);
session.on_set_name(name);
session.on_add_sheet(new_sheet_id);
```

Each hook runs AFTER the corresponding workbook mutation succeeds. The hooks update graph state (node addition, edge updates, dirty propagation). **Phase 3.1 hooks are STUBS** — they update the cell index where applicable and increment counters for observability, but they don't propagate dirty bits or update edges. Phase 3.3 (`Dirty Propagation And Stripe Range Index`) makes them load-bearing.

The 5-hook surface covers every public producer mutation in `WorkbookRuntime`:

| Runtime method | Hook | Phase 3.3 behavior |
|---|---|---|
| `set_value(s, r, c, v)` | `on_set_value(s, r, c)` | Mark direct dependents + range dependents dirty via `Graph::dependents_for_cell` |
| `set_value` over formula | `+ on_clear_formula(s, r, c)` | Remove outgoing edges (old deps) before re-marking dirty |
| `set_formula(s, r, c, text)` | `on_set_formula(s, r, c, text)` | Lex+parse+bind text, attach new outgoing edges (deps), mark dependents dirty |
| `clear_formula(s, r, c)` | `on_clear_formula(s, r, c)` | Remove outgoing edges |
| `set_name(name, target)` | `on_set_name(name)` | Mark all formulas with `NameRef(name)` dirty |
| `add_sheet(name, chunk_rows)` | `on_add_sheet(new_id)` | Track per-sheet structure generation (Phase 4.6 cross-sheet refs) |

## 2.3 Dirty propagation (Phase 3.3, shipped W5-36)

Each hook now drives the session's `dirty: HashSet<NodeId>`:

| Hook | Dirty fanout |
|---|---|
| `on_set_value(s,r,c)` | Union of `Graph::dependents_for_cell(s,r,c)` (stripe-precision-filtered range deps) and `cell_to_formulas[(s,r,c)]` (session-side reverse index for direct `ExprPlan::CellRef` deps). |
| `on_set_formula(s,r,c,plan)` | Extract + register deps (cell reverse index + stripe), then propagate dirty downstream via `mark_dirty_from_cell_write(s,r,c)`. The formula itself is NOT marked dirty — the runtime wrote a fresh value before the hook fired. |
| `on_clear_formula(s,r,c)` | Evict session-side deps + drop the cleared formula from the dirty set, then propagate dirty downstream (dependents need to recompute because the cleared formula no longer produces its prior value). |
| `on_set_name(name)` | Look up `name_to_formulas[name]` (case-insensitive); mark all referencing formulas dirty. Today only `AggregateNameRef` populates this index — scalar `NameRef` precision is GAP-R-07, deferred to Phase 4. |
| `on_add_sheet(_)` | No-op (no formulas exist on the new sheet yet). |

The public API for the scheduler:

```rust
session.dirty_formulas() -> &HashSet<NodeId>   // read-only view
session.is_dirty(node)   -> bool
session.take_dirty()     -> HashSet<NodeId>    // atomic claim + clear
session.cell_dep_count() -> usize              // observability
```

Phase 3.4 plugs Tarjan SCC over the `take_dirty()` set to recompute in topological order (cycles surface as `#CIRC!`).

### Stale stripes on re-bind (GAP-G-01)

The Phase 0 `Graph` is append-only — no API to remove edges or revoke a `register_range_dependency`. When a formula's text changes from `=SUM(A:A)` to `=SUM(B:B)`, the OLD Column A stripe entry persists, and `formula_to_range_deps[formula_node]` keeps both ranges. A subsequent write to A5 hits the Column A stripe AND passes the precision check (the stale `A:A` range still contains A5) — false-positive dirty.

**Cost: performance, not correctness.** A false-positive dirty just means a recompute does extra work; the value is unchanged so downstream sees no propagation. Phase 3.10 megaudit decides between delta-edge graph storage vs a per-formula `Graph::clear_range_deps_for_formula(node)` API; Phase 3.3 ships with the residue documented.

## 3. What Phase 3.3 deliberately doesn't ship

These are tracked in `docs/known-gaps.md` and pinned to specific Phase 3 sub-items:

- ✅ **Dependency extraction (Phase 3.2 / W5-35):** the dep walker + `FormulaDeps` collection + `cell_to_formulas` / `name_to_formulas` / `volatile_formulas` side-tables are all live.
- ✅ **Dirty propagation (Phase 3.3 + 3.4 / W5-36, W5-37):** the 5 hooks fan out via stripe + reverse index. Phase 3.4 added BFS for transitive propagation so chain edits cascade. `dirty_formulas()` / `take_dirty()` / `schedule_dirty()` are the scheduler hooks.
- ✅ **Topological recompute (Phase 3.4 / W5-37):** `WorkbookRuntime::recompute_dirty()` runs the Phase 0 W3-3 iterative Tarjan over the dirty set. `sorted` goes through the PlanCache evaluator; `cycled` gets `Value::Error(ErrorValue::Circ)`. `recompute_all` stays as the full-pass legacy entry point (`GAP-R-01` retargeted to Phase 6.1 for the API rename decision).
- **Computed-overlay separation (Phase 3.5):** user edits and formula outputs share the same storage overlay today. Phase 3.5 splits them per CORR-25.
- **Range aggregate cache (Phase 3.6):** `ExprPlan::AggregateNameRef` currently evaluates to `#CALC!`. Phase 3.6 implements actual range aggregate evaluation with HyperFormula-style per-function-name caching on RangeNodes.
- **Volatile function invalidation (Phase 3.7):** `NOW()`, `RAND()`, `TODAY()` parse and evaluate today but have no dirty-propagation hook.
- **Value-equality short-circuit (Phase 3.8):** unchanged upstream still dirties downstream.

The full Phase 3 sub-item list is in `docs/MASTER-PLAN.md` Phase 3.

## 4. Backward compatibility

`CalcgraphSession` is **opt-in**. A runtime constructed without one behaves exactly as Phase 2B's runtime:

```rust
let mut rt = WorkbookRuntime::new(&mut wb, &reg);  // no graph, no oplog
let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);  // no graph
let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);  // no oplog
let mut rt = WorkbookRuntime::with_oplog_and_graph(&mut wb, &reg, &mut oplog, &mut graph);
```

Existing callers (the IDE simulation test, the e2e tests, all the unit tests) continue to use `new` or `with_oplog` and are unaffected. The 4-constructor surface is a transitional shape; Phase 6.1 collapses it.

## 5. Test coverage (acceptance G3-01..03)

- **G3-01** (deterministic rebuild): `rebuild_is_deterministic_across_runs` in `calcgraph_session.rs::tests` rebuilds 10 times from the same workbook and asserts identical node IDs.
- **G3-02** (5 mutation hooks):
  - `mutation_hooks_each_bump_their_counter` (calcgraph_session unit) — hooks individually addressable.
  - `runtime_mutations_fire_calcgraph_hooks` (workbook_runtime test) — every runtime method drives its hook.
- **G3-03** (no petgraph hot path): `graph_construction_uses_no_petgraph_types` (calcgraph_session unit). The Round 7 T1-D02 lock holds; nothing in 3.1 introduces a graph library.

Plus 4 wiring tests in `workbook_runtime.rs`:
- `rebuild_then_edit_keeps_cell_index_in_sync`
- `runtime_without_graph_works_as_before` (regression guard)
- `runtime_with_oplog_and_graph_drives_both`

## 6. References consulted

- `.references/formualizer/crates/formualizer-eval/src/engine/graph/mod.rs` — the orchestrator pattern for graph-runtime integration.
- `.references/formualizer/crates/formualizer-eval/src/engine/vertex_store.rs` — vertex ID space (Phase 0 W3-1 already adopted the append-only u32 pattern).
- `.references/hyperformula/src/DependencyGraph/DependencyGraph.ts` — TypeScript counterpart; GPLv3, patterns only.

Each Phase 3 sub-item lists its specific reference files in `docs/MASTER-PLAN.md`.
