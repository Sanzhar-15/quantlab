# Quantbook Engine Master Plan

**Status:** Canonical engine-side plan, Phase 4.3 V2 closure session 2026-05-13  
**Date:** 2026-05-13 (last touched W5-58 — FN4-01 closure)  
**Current HEAD:** see `docs/audits/2026-05-13-engine-session-final-handoff.md` § Session ledger for the exact hash (last shippable W5-58 = `d6a6bcdcfc5`; W5-59 finalization = `51fedf11c68`; W5-60 closure adds the final mega-audit fixes on top)  
**Scope:** engine-internal sequencing for all 24 workspace crates  
**Authored:** Claude Opus 4.7 + Codex (co-thinking session, 2026-05-12)

This is the long path. There is no MVP shortcut in this plan. The v1 target is a real spreadsheet engine backing Quantlab: correct scalar semantics, fast graph-driven recomputation, Excel coverage, collaboration, import/export, bindings, service mode, Python UDFs, SQL, connectors, AI(), and an exercised IDE integration.

---

## 0. How this document relates to the product master plan

There is a **canonical product master plan** for Quantbook at:

> `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md`

That document (dated 2026-05-10, 949 lines) is the **product source-of-truth**: the fusion thesis, the wedge, the v1 ship definition, the 11-phase / 9-12 month budget, the kill gates, the v1.5 deferrals, the legal posture, the renderer/Python/IDE phase plan. It is gitignored (lives outside this engine worktree). Future sessions should read it before making product-level decisions.

This `MASTER-PLAN.md` is the **engine-side execution plan**: how the Rust engine work proceeds from where it is today (HEAD at W5-60 closure, post-FN4-01 wave 1 closure + final mega-audit fixes; see `docs/audits/2026-05-13-engine-session-final-handoff.md` for the precise hash) through to a state where every product-plan phase that needs engine support has it. It uses engine-internal phase numbers (`2B`, `3`, `4`, `5`, `6`, `7`) that DO NOT align with the canonical plan's numbering (`Phase 0..10`).

### Mapping between engine-internal phases and canonical product phases

| Engine phase (this doc) | Canonical product phase(s) | Notes |
|---|---|---|
| Engine 0 (Viability spike) ✅ | Product Phase 0 | Same. 13/13 gates locked. |
| Engine 1 (Parser + persistence + runtime facade) ✅ | Product Phase 0 spillover + parts of Phase 2 (`.qbook/`) + parts of Phase 3 (parser, recompute) | Engine front-ran the canonical plan by absorbing parts of Phase 2 storage and Phase 3 parser. |
| Engine 2A.1–2A.13 ✅ | Parts of Product Phase 3 (named ranges, errors, fingerprints, parser breadth) | Engine correctness + audit closure. |
| Engine 2A.3 (op log) ✅ | Product Phase 0 deliverable (`ql-oplog` scaffolding) advanced into producer wiring + persistence | Loro op log scaffolding called for in canonical Phase 0; we shipped it now because the API surface was ready. |
| **Engine 2B (Correct Runtime Contract)** | Product Phase 3 (continued) + Product Phase 6 (first IDE integration vertical slice) | First time the IDE is exercised against the engine. |
| **Engine 3 (One Engine — calcgraph integration)** | Product Phase 3 (the unified engine spine the canonical plan assumed in §2.1) | The canonical plan describes "one authoritative graph"; Engine 3 actually builds that. |
| **Engine 4 (Excel Coverage)** | Product Phase 3 (depth) + Product Phase 4 (xlsx import) | Roughly 260 functions + arrays/spills/tables/cross-sheet refs + xlsx I/O. |
| **Engine 5 (Collaboration CRDT)** | Product Phase 9 (deferred to v1.5 per canonical plan) | Canonical plan defers full collab to v1.5; engine-side, when this work happens, it lives here. May be cut from v1 per canonical. |
| **Engine 6 (Product Surfaces)** | Product Phase 5 (Python kernel + UDFs) + Phase 6 (VS Code surface) + Phase 7 (UX) + Phase 8 (SQL/connectors) | The canonical plan splits these across four product phases; the engine work to support them is sequenced here. The TypeScript/UI work in canonical phases 1, 7 lives in `Charts/packages/sheets-*` and `extensions/quantlab/`, NOT in this engine worktree. |
| **Engine 7 (Hardening + Ship)** | Product Phase 10 | Same. Final release candidate. |

**Where the engine plan does NOT cover canonical phases:**

- **Canonical Phase 1 (Renderer spike, WebGL grid)** — entirely TypeScript work in `Charts/packages/sheets-{protocol,client,renderer}`. Engine provides the API surface; renderer is its own project. No engine-side phase covers it.
- **Canonical Phase 2 (storage + protocol + skeleton packages)** — engine has shipped the `.qbook/` storage piece; the `sheets-protocol`/`sheets-client` TypeScript packages are renderer-team work.
- **Canonical Phase 6 (Quantlab IDE integration)** — the engine's job is to provide a usable API; the actual `extensions/quantlab/` work is a parallel TypeScript track. Engine 2B includes the first vertical slice as a forcing function.

### Why two documents

The canonical plan is product-shaped and parallel-track (engine + renderer + Python + IDE proceeding in measured concurrency). The actual execution since 2026-05-11 has been engine-serial: depth-first through the Rust core. This engine plan reflects that reality and extends it. Future sessions should:

1. Open the canonical plan to understand product intent, v1 definition, ship gates.
2. Open this engine plan to know what to build next in the engine.
3. When the two diverge, **the canonical plan wins on product scope and timing**; this doc adjusts.

## PART I - Strategic Posture

### 1. How We Got Here

Phase 0 proved that the engine shape is viable. The locked architectural gates are still binding:

- T1-D02: hand-rolled dependency graph on the hot path, not petgraph.
- T1-D03: direct Arrow kernels on the hot path, not Polars or DataFusion.
- T1-D04: pulp plus multiversion SIMD.
- T1-D05: Loro reserved for operation history and collaboration substrate work, not evaluator state.
- T1-D06: stock VS Code APIs for v1.
- T1-D07: Tier-0 wedge is Monaco-powered formula bar plus Python UDFs.
- T2-D01: `.qbook/` directory plus `workbook.toml` envelope.
- T3-D03: roughly 260 v1 spreadsheet functions.

Phase 1 built the first live formula path: lexer, parser, AST printer, scalar binding, scalar evaluation, `.qbook/` persistence, `WorkbookRuntime::set_formula`, and `recompute_all`. It made the engine useful, but it did not make it architecturally complete. `recompute_all` still walks formula cells in map order, so dependency chains can compute incorrectly.

Phase 2A closed a large correctness and persistence pass: defined names, transactions, load-and-recompute, dotted function identifiers, schema v2, crash-safe save, Excel-canon coercion fixes, deterministic formula fingerprints, error ergonomics, and audit closure. Phase 2A.3 then shipped Loro-backed op-log scaffolding: `ql-oplog`, typed `Op` variants, Loro snapshot persistence, replay, runtime and transaction producer wiring, and `.qbook/oplog.bin` persistence. The stale `docs/phase2/entry-plan.md` and `docs/phase2/exit-packet.md` still say 2A.3 is deferred; this plan supersedes that statement and requires a doc-rot repair pass in Phase 2B.

The engine now has **1219 workspace tests at W5-60 close** (was 816 at the time this paragraph was first written; ~+403 across the W5-49..W5-60 arc) and 7 green gates. That is a floor, not a trophy. The major unresolved problem is that the "fast engine" (`ql-calcgraph`, SIMD region lowering, storage profiles) and the "runtime engine" (`WorkbookRuntime`, per-formula scalar path) still do not form one engine.

Reference reading already changed the plan:

- `docs/phase0/references-reading-log.md` corrected the stripe design to Formualizer-style per-row/per-column/block stripes (`CORR-21`).
- Range aggregate caching is a Phase 3/4 feature informed by HyperFormula, not Formualizer (`CORR-22`).
- Scheduling should use Tarjan SCC on dirty subsets (`CORR-23`).
- Graph tests should expose typed accessors, not serialized graph dumps (`CORR-24`).
- Storage eventually needs user and computed overlays (`CORR-25`).

### 2. What Full Product v1 Means

The 24-crate workspace is v1 scope. Stubs are not optional decorations; they are reserved product surfaces.

| Crate | v1 role |
|---|---|
| `ql-types` | shared values, errors, addresses, coercion, date serials, sheet/range types |
| `ql-storage` | workbook, sheets, columns, user/computed overlays, names, tables, style/format metadata |
| `ql-formula-syntax` | lexer, parser, printer, fingerprints, A1/R1C1/localized syntax |
| `ql-formula-semantics` | binding, name resolution, tables, cross-sheet references, aggregate context |
| `ql-functions` | roughly 260 Excel-compatible functions, function metadata, volatility, lazy args |
| `ql-calcgraph` | dependency graph, dirty propagation, SCC scheduling, range deps, aggregate caches |
| `ql-exec` | runtime facade, scalar and SIMD evaluation, plan cache, graph integration |
| `ql-io` | `.qbook` persistence and schema migrations |
| `ql-oplog` | mutation history, replay, future collaborative operation vocabulary |
| `ql-profile` | timings, graph profile exports, observability records |
| `ql-bench` | reproducible perf and scale workloads |
| `ql-io-xlsx` | Excel import/export through calamine and write support |
| `ql-io-ods` | OpenDocument import/export |
| `ql-collab` | multi-user CRDT documents, merge, presence, undo/redo, offline sync |
| `ql-service` | engine-as-service API, transport, auth boundary hooks |
| `ql-bindings-wasm` | browser/worker engine bindings |
| `ql-bindings-node` | IDE and Node integration surface |
| `ql-bindings-c` | stable C ABI |
| `quantbook-py` | Python package for local automation and notebooks |
| `ql-udf` | Python UDF execution, sandboxing, registration, cancellation |
| `ql-sql` | SQL over sheets/tables, Arrow/DuckDB bridge where appropriate |
| `ql-connectors` | external data imports, refresh, credentials boundary |
| `ql-ai` | real AI() implementation, provider boundary, cancellation, provenance |
| `ql-terminal` | terminal-side integration only if it survives product clarification |

The full v1 means all of these crates either ship real behavior or have a documented product decision removing them. As of this plan, none are removed.

### 3. Seven Phases At A Glance

| Phase | Name | Purpose | Estimate | Primary proof |
|---|---|---|---:|---|
| 2B | Correct Runtime Contract | Fix immediate runtime correctness gaps, cache bind plans, prepare named aggregate context, and run the first IDE vertical slice. | 2-4 weeks | IDE can edit formulas through the engine with real diagnostics and op-log persistence. |
| 3 | One Engine | Wire `ql-calcgraph` into `WorkbookRuntime` so runtime and fast engine share graph, storage, invalidation, and scheduling. | 4-8 weeks | Dependency chains, ranges, volatiles, and incremental recompute are graph-driven. |
| 4 | Excel Coverage | Expand parser, semantics, function library, arrays, tables, cross-sheet refs, formats, and xlsx I/O. | 8-16 weeks | Compatibility matrix exists and passes broad Excel corpus coverage. |
| 5 | Collaboration | Make Loro a true multi-user substrate for cells, sheets, names, tables, and presence. | 6-12 weeks | Two offline peers merge deterministically without losing edits. |
| 6 | Product Surfaces | Ship service mode, bindings, connectors, SQL, Python UDFs, and AI(). | 6-10 weeks | IDE, Node, Python, WASM, and service clients run the same engine contract. |
| 7 | Hardening And Ship | Performance, observability, release artifacts, audits, scale tests, and IDE polish. | 4-6 weeks | End-to-end release candidate survives scale, audit, and IDE acceptance. |

## PART II - Phase Plans

## Phase 2B - Correct Runtime Contract

**Purpose:** Make current runtime semantics honest enough for the IDE while preparing the bind and aggregate context that Phase 3 will graph-drive.

**Entry State Required**

- Phase 0, Phase 1, Phase 2A, and Phase 2A.3 are green at HEAD `fc977815cd2`.
- `ql-oplog` producer/replay tests pass.
- `docs/phase2/*` are known stale; do not trust their 2A.3 deferral statement.

**Dependencies**

- Depends on Phase 2A.3 op-log producer wiring.
- Must not require full calcgraph integration; that is Phase 3.
- Must coordinate with `extensions/quantlab/` for first IDE slice.

**Sub-items**

1. **2B.1 Doc-Rot Repair And Reality Baseline**  
   Update `docs/phase2/entry-plan.md`, `docs/phase2/exit-packet.md`, phase maps, and this file to mark 2A.3 shipped. Add a "current known gaps" checklist with owners.  
   References: `docs/phase0/references-reading-log.md`; `crates/ql-oplog/src/{op,log,replay,persistence}.rs`; `crates/ql-exec/tests/oplog_e2e.rs`.  
   Acceptance: DOC-2B-01 all Phase 2 docs agree that 2A.3 shipped; DOC-2B-02 every known gap has a target phase; DOC-2B-03 no stale "Phase 4 calcgraph" wording remains where Phase 3 is meant.  
   Effort: 1 day.

2. **2B.2 Recompute Result Contract**  
   Replace short-circuit-only `recompute_all` reporting with `RecomputeResult` containing attempted count, succeeded count, failed cell, failure kind, and partial-state policy. Keep no-fallbacks: failures are visible.  
   References: `.references/formualizer/crates/formualizer-workbook/src/recalculate.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/eval.rs`; `.references/hyperformula/src/Evaluator.ts` only for failure reporting concepts if needed.  
   Acceptance: R2B-01 failure returns exact cell and formula text; R2B-02 successful earlier cells are counted; R2B-03 no panic on invalid persisted formula; R2B-04 load-and-recompute preserves partial workbook on recompute failure.  
   Effort: 2-3 days.

3. **2B.3 Bind-Plan Cache V0**  
   Cache parsed and bound `ExprPlan` next to workbook formula text, keyed by formula fingerprint plus sheet/name-table generation. Invalidate on formula text change, name-table mutation, and sheet add. Keep cache local to runtime/storage; do not invent graph scheduling here.  
   References: `.references/hyperformula/src/parser/ParserWithCaching.ts`; `.references/hyperformula/src/parser/Cache.ts`; `.references/formualizer/crates/formualizer-eval/src/engine/graph/formula_analysis.rs`.  
   Acceptance: BPC-01 repeated `recompute_all` does not re-lex/re-parse unchanged formulas; BPC-02 name changes invalidate affected plans; BPC-03 fingerprints remain stable; BPC-04 cache miss/hit counters visible in `ql-profile`.  
   Effort: 3-5 days.

4. **2B.4 Named-Range Aggregate Context Prep** ✅ SHIPPED (`f64ff00dcb1`)  
   Bind `SUM(Sales)` to a typed `ExprPlan::AggregateNameRef { name, range }` instead of generic `UnsupportedVariant`; scalar-context misuse surfaces precise `BindError::NamedRangeInScalarContext`. Evaluation returns `#CALC!` for AggregateNameRef pending Phase 3.6. **Deviation from original plan:** the work stays in `ql-exec/src/plan.rs` rather than moving to `ql-formula-semantics`. The move was deferred because `ExprPlan` lives in `ql-exec`; relocating it cleanly requires Phase 3 calcgraph integration to land first (so the eventual home is `ql-formula-semantics` once ownership questions resolve). Tracked as a follow-up; not a 2B.4 blocker.  
   References used: same as planned (formualizer + hyperformula).  
   Acceptance shipped: NAG-01..04 + `nag_05_nested_aggregates_with_named_range_bind_cleanly` + `nag_06_round_with_nested_sum_of_named_range_binds_cleanly`.  
   Effort actual: ~1 day (binder context threading + new variants + tests).

5. **2B.5 Op-Log Producer Coverage Audit**  
   Close silent bypasses: `Workbook::set_name`, `Workbook::add_sheet`, and direct `put_at` paths either emit ops through a runtime/transaction facade or are marked low-level with tests proving callers cannot accidentally use them from product surfaces.  
   References: `crates/ql-oplog/src/op.rs`; `.references/formualizer/crates/formualizer-workbook/src/transaction.rs`; `.references/formualizer/crates/formualizer-sheetport/src/batch.rs`.  
   Acceptance: OPL-2B-01 every public product mutation has an op-log equivalent; OPL-2B-02 producer/replay equivalence covers values, formulas, names, sheets, and batches; OPL-2B-03 low-level bypass methods carry explicit docs and tests.  
   Effort: 2-3 days.

6. **2B.6 First IDE Vertical Slice**  
   Exercise `extensions/quantlab/` against the engine path: edit a formula in a Monaco-powered formula bar, get diagnostics, commit/cancel, paste a small block, save `.qbook`, reload, and verify `oplog.bin`. Use stock VS Code APIs.  
   References: `.references/formualizer/crates/formualizer-sheetport/src/session.rs`; `.references/formualizer/bindings/wasm/src/index.ts` for binding-shape ideas; VS Code API docs already vendored in the host repo.  
   Acceptance: IDE-2B-01 formula edit calls engine and displays value; IDE-2B-02 lex/parse/bind errors display without falling back; IDE-2B-03 cancel leaves workbook unchanged; IDE-2B-04 paste uses transaction API; IDE-2B-05 saved workbook reloads with same visible state and op log length.  
   Effort: 4-7 days, split between engine and IDE worktree.

7. **2B.7 Phase 2B Audit And Gate Lock**  
   Dispatch independent audit after 2B.2-2B.6. Fix HIGH findings, triage MEDIUM, document deferrals.  
   References: prior audit docs under `docs/audits/`; `scripts/check-*.sh`.  
   Acceptance: A2B-01 fmt, clippy, workspace tests, pin guard, build flags, multiversion clone guard, cargo audit all green; A2B-02 test count at least 1.5x Phase 2A.3 baseline or explicit exception; A2B-03 audit report checked in.  
   Effort: 2-3 days.

**Audit Checkpoints**

- Mini-audit after 2B.5 focused on op-log coverage and no-fallbacks.
- Full Phase 2B audit after IDE slice.

**IDE Proof Points**

- This phase owns the first IDE vertical slice.
- It must prove the `set_formula` contract, cancellation, diagnostics, paste transaction, save/load, and op-log persistence.

**Exit Criteria**

- `recompute_all` failure reporting is explicit.
- Bind-plan cache exists and invalidates correctly.
- Named-range aggregate binding has a typed plan shape.
- IDE vertical slice is exercised, not hand-waved.
- Phase docs no longer lie about 2A.3.

**Documentation Deliverables**

- `docs/phase2/entry-plan.md` repaired.
- `docs/phase2/exit-packet.md` repaired.
- `docs/phase2b/entry-plan.md`.
- `docs/phase2b/exit-packet.md`.
- Audit report under `docs/audits/`.

## Phase 3 - One Engine

**Purpose:** Integrate `ql-calcgraph` with `WorkbookRuntime` so dependency tracking, storage, scheduling, scalar evaluation, SIMD regions, and recomputation are one runtime.

**Entry State Required**

- Phase 2B exit gates green.
- Bind-plan cache V0 exists.
- IDE slice has exposed the real runtime contract.

**Dependencies**

- Requires 2B bind-plan cache and aggregate context prep.
- Blocks Phase 4 arrays, tables, cross-sheet scale work, and xlsx formulas at meaningful scale.

**Sub-items**

1. **3.1 Calcgraph Runtime Ownership Model** ✅ SHIPPED 2026-05-12 (W5-34)  
   Decide where graph state lives: likely inside `WorkbookRuntime` session state with persistable rebuild from workbook formulas, not inside `Workbook` storage alone. Define rebuild, mutation, and snapshot APIs.  
   References: `.references/formualizer/crates/formualizer-eval/src/engine/graph/mod.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/vertex_store.rs`; `.references/hyperformula/src/DependencyGraph/DependencyGraph.ts`.  
   Acceptance: G3-01 ✅ graph rebuilds deterministically (`rebuild_is_deterministic_across_runs`); G3-02 ✅ 5-hook mutation API (`on_set_value`, `on_set_formula`, `on_clear_formula`, `on_set_name`, `on_add_sheet`); G3-03 ✅ no petgraph hot-path dep — Phase 0 W3-1 hand-rolled `Graph` per Round 7 T1-D02 lock.  
   Shipped: `CalcgraphSession` ownership shell at `crates/ql-exec/src/calcgraph_session.rs`; constructor variants (`new`, `with_oplog`, `with_graph`, `with_oplog_and_graph`); 11 unit tests + 4 wiring tests in `workbook_runtime.rs`. Future Phase 6.1 `WorkbookSession` will absorb Workbook + OpLog + CalcgraphSession + PlanCache + FunctionRegistry into one owning struct (GAP-PS-09).  
   Effort: 3-4 days.

2. **3.2 Dependency Extraction From Bound Plans** ✅ SHIPPED 2026-05-12 (W5-35)  
   Extract cell, range, name, volatile, and future table dependencies from `ExprPlan`. Preserve compressed range dependencies for whole-column/whole-row ranges.  
   References: `.references/formualizer/crates/formualizer-eval/src/engine/graph/formula_analysis.rs`; `.references/hyperformula/src/parser/collectDependencies.ts`; `.references/hyperformula/src/parser/RelativeDependency.ts`.  
   Acceptance: DEP-3-01 ✅ direct cell deps captured (`dep_3_01_direct_cell_refs_captured`); DEP-3-02 ✅ range deps remain compressed (`dep_3_02_range_deps_remain_compressed`); DEP-3-03 ✅ named deps captured (`dep_3_03_named_deps_captured`); DEP-3-04 ✅ volatile functions marked (`dep_3_04_volatile_functions_marked`).  
   Shipped: `CalcgraphSession::{formula_deps, volatile_formulas, name_to_formulas}` side-tables; `walk_plan_for_deps` recursive walker; `RebuildResult` aggregates per-formula bind failures (parallel to `RecomputeResult`); `on_set_formula` takes `&ExprPlan` (no re-binding in the hook); `on_clear_formula` evicts dep state. 9 new tests; full ql-exec suite at 268 tests. Open follow-ups: GAP-R-07 (scalar `NameRef` name-tracking) and the 3.3 dirty-propagation wire-up that consumes this substrate.  
   Effort: 3-5 days (actual: ~1 day from 3.1 substrate; clean handoff to 3.3).

3. **3.3 Dirty Propagation And Stripe Range Index** ✅ SHIPPED 2026-05-12 (W5-36)  
   Wire writes to dirty direct dependents and range dependents through Formualizer-style stripe maps. Add precision re-check to remove false positives.  
   References: `.references/formualizer/crates/formualizer-eval/src/engine/graph/range_deps.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/graph/mod.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/sheet_index.rs`.  
   Acceptance: DIR-3-01 ✅ write inside range dirties dependent (`dir_3_01_write_inside_range_dirties_dependent`); DIR-3-02 ✅ write outside range does not dirty after precision check (`dir_3_02_write_outside_range_filtered_by_precision_check`); DIR-3-03 ✅ whole-row, whole-column, and bounded ranges covered (`dir_3_03_whole_col_whole_row_bounded_all_supported`); DIR-3-04 ✅ no per-cell edge explosion for full columns (`dir_3_04_no_per_cell_edge_explosion_for_full_columns`).  
   Shipped: session-side `dirty: HashSet<NodeId>` plus the 5 hooks fanning out via `Graph::dependents_for_cell` (stripe + precision) for range deps and a new session-side `cell_to_formulas` reverse index for direct cell deps; `on_set_name` fans out via `name_to_formulas`; `take_dirty()` claims + clears for the future 3.4 SCC scheduler; `range_to_rangeref` converter promotes `Range { start_row: 0, end_row: MAX }` to `RangeRef::WholeColumn` (and symmetric for whole-row) to keep the stripe index O(width) instead of O(height). 10 new tests; full ql-exec suite at 278 tests, workspace at 892. Known limitation: stale Phase 0 stripe entries on re-bind (append-only `Graph`) — filed as GAP-G-01 (performance, not correctness; precision check filters at the read side).  
   Effort: 4-6 days (actual: ~1 day; substrate already existed in `ql-calcgraph` from Phase 0 W3-5).

4. **3.4 Tarjan SCC Scheduler And Full Topological Recompute** ✅ SHIPPED 2026-05-12 (W5-37)  
   Replace map-order recompute with dirty-subset Tarjan SCC plus deterministic layers. Cycles surface as Excel errors and diagnostics, not panics.  
   References: `.references/formualizer/crates/formualizer-eval/src/engine/scheduler.rs`; `.references/hyperformula/src/DependencyGraph/TopSort.ts`; `docs/phase0/references-reading-log.md` CORR-23.  
   Acceptance: SCH-3-01 ✅ dependency chains schedule in dependency-first order (`sch_3_01_dependency_chains_schedule_in_dependency_first_order` + `recompute_dirty_cascades_dependency_chain`); SCH-3-02 ✅ cycles surface in `Schedule::cycled` (`sch_3_02_cycles_report_all_scc_members` + `recompute_dirty_writes_circ_error_for_cycle_members`); SCH-3-03 ✅ deterministic across runs (`sch_3_03_schedule_is_deterministic_across_runs`); SCH-3-04 ✅ dirty subset avoids unrelated formulas (`sch_3_04_dirty_subset_avoids_unrelated_formulas` + `recompute_dirty_skips_unrelated_formulas`).  
   Shipped:  
   - Phase 0 W3-3 iterative Tarjan in `ql_calcgraph::topo::schedule` was already built (no recursion limit on deep chains). 3.4 wires it.  
   - `extract_and_register_deps` adds forward `graph.add_edge(formula, dep_formula)` for direct cell→cell deps (self-edges allowed for `=A1` at A1 → Tarjan reports as cycled).  
   - `on_set_formula` does retroactive-edge wiring: when a new formula appears at a cell that older formulas already reference, the F'→F forward edges are materialized so Tarjan can order them.  
   - `rebuild_from_workbook` pre-inserts all formula nodes before any extract pass so the forward-edge wiring at extract time sees a complete `cell_index`.  
   - `mark_dirty_from_cell_write` upgraded from single-hop (Phase 3.3) to BFS — a chain edit cascades through the reverse-dep graph until fixpoint.  
   - `CalcgraphSession::schedule_dirty() -> Schedule` drains the dirty set and runs Tarjan.  
   - `CalcgraphSession::cell_address_for(NodeId)` — inverse of `cell_node_for`, needed by the runtime to look up addresses from schedule output.  
   - `WorkbookRuntime::recompute_dirty()` evaluates the `sorted` partition in dependency-first order via the existing PlanCache pipeline; writes `Value::Error(ErrorValue::Circ)` for every `cycled` member.  
   - New `ErrorValue::Circ` variant (15th, was reserved at Phase 0; Phase 0 doc updated). Handled in `ql-io::qbook_format` wire roundtrip.  
   16 new tests (10 session unit + 5 runtime integration + 1 wire roundtrip). ql-exec at 295, workspace at 905.  
   Effort: 5-7 days (actual: ~1 day; substrate was already there from Phase 0 W3-3).

5. **3.5 Computed-Overlay Separation** ✅ SHIPPED 2026-05-12 (W5-38)  
   Split user edits from computed formula/spill outputs in storage. Reads cascade user -> computed -> base. User write clears stale computed value at that cell.  
   References: `.references/formualizer/crates/formualizer-eval/src/arrow_store/mod.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/range_view.rs`; `docs/phase0/references-reading-log.md` CORR-25.  
   Acceptance: OVR-3-01 ✅ formula output writes to computed overlay, not user (`ovr_3_01_set_formula_writes_to_computed_overlay_not_user`); OVR-3-02 ✅ typing over formula clears formula text + computed (`ovr_3_02_typing_over_formula_clears_formula_and_computed`); OVR-3-03 ✅ save/load preserves layer (`ovr_3_03_save_load_preserves_layer`); OVR-3-04 ✅ read cascade consistent (`ovr_3_04_read_cascade_consistent_across_lane_types`).  
   Shipped:  
   - `ColumnStore` now carries `user_overlays: Vec<SparseOverlay>` AND `computed_overlays: Vec<SparseOverlay>` (parallel per-chunk). Read cascade: user → computed → base.  
   - `ColumnStore::put` (user edit) auto-clears computed at the row; symmetric `put_computed` clears user. The two lanes maintain the invariant "a row has at most one of {user, computed} entry."  
   - `ColumnStore::{clear_computed, clear_user}` for explicit lane drops.  
   - `Sheet::{put_computed, clear_computed, clear_user}` mirror the column API.  
   - `Workbook::{put_computed_at, clear_computed_at, clear_user_at}`. `Workbook::clear_formula` ALSO drops the cell's computed entry (no formula → no formula output).  
   - `WorkbookRuntime::{set_formula, recompute_all, recompute_dirty}` route formula outputs through `put_computed_at` (was `put_at`); `clear_formula` runtime path promotes the final formula value into the user lane before clearing (Excel "strip formula, keep value" canonicalized to "value becomes literal"). Transaction commit pass 2 routes formula results through `put_computed_at`.  
   - `WorkbookRuntime::recompute_dirty` writes `#CIRC!` to the computed overlay (not user) for cycle members.  
   - qbook loader (`ql_io::load_workbook`) routes cells with formula text to `put_computed_at`; cells without formulas go to `put_at` (user). Save path needs no change — `sheet.read` already goes through the cascade and surfaces the right value per cell.  
   - `iter_chunks` signature changed: `(idx, &base, &user_overlay, &computed_overlay)` tuple. `overlay(idx)` deprecated; new code uses `user_overlay` / `computed_overlay` explicitly.  
   - One additional Phase 3.5 acceptance test `ovr_3_02b_clear_formula_promotes_value_to_user_lane` pins the explicit-clear behavior.  
   10 new tests (5 in ColumnStore + 5 OVR-* at runtime). ql-exec at 305 (was 295), ql-storage at 70 (was 65), workspace at 915 (was 905).  
   Effort: 4-7 days (actual: ~1 day; the overlay primitive was already per-chunk, so the split was straightforward).

6. **3.6 Range Aggregate Cache V1** ✅ SHIPPED 2026-05-12 (W5-39)  
   Add aggregate cache nodes for SUM/COUNT/MIN/MAX/AVERAGE/PRODUCT over range plans, invalidated by dirty stripes. Start simple: clear relevant aggregate cache on intersecting writes; optimize later.  
   References: `.references/hyperformula/src/DependencyGraph/RangeVertex.ts`; `.references/hyperformula/src/DependencyGraph/RangeMapping.ts`; `.references/formualizer/crates/formualizer-eval/src/engine/tests/compressed_range_scheduler.rs`.  
   Acceptance: AGG-3-01 ✅ unrelated writes don't trigger rescan (`agg_3_01_no_rescan_on_unrelated_writes`); AGG-3-02 ✅ intersecting writes invalidate (`agg_3_02_intersecting_write_invalidates_cache`); AGG-3-03 ✅ full-column aggregate remains compressed (`agg_3_03_full_column_aggregate_remains_compressed`); AGG-3-04 ✅ results match scalar baseline for SUM/AVERAGE/MIN/MAX/COUNT/PRODUCT (`agg_3_04_results_match_scalar_baseline`).  
   Shipped:  
   - New module `aggregate_cache.rs`: `AggregateCache` trait, `InMemAggregateCache` (HashMap-backed with `RefCell` interior mutability for `&self` stores), `NoAggregateCache` zero-cost no-op default. Stats: hits / misses / invalidations.  
   - `CellEnv::read_range(range)` — default impl iterates row-by-row; `WorkbookEnv` overrides to clamp to `Sheet::bounds` so `SUM(WholeCol)` doesn't iterate `RowId::MAX` cells.  
   - Aggregate evaluator: scalar.rs Function branch detects `(aggregate_fn, [single AggregateNameRef arg])` and routes through cache (hit → return cached; miss → materialize range → call fn → store cached, except for `Value::Error` results). Multi-range aggregates (`SUM(A, B)`) fall back to no-cache materialize-and-call.  
   - `eval_scalar_with_cache(plan, env, registry, &dyn AggregateCache)` is the new entry point; `eval_scalar_with_registry` wraps with `NoAggregateCache`.  
   - `CalcgraphSession::aggregate_cache: InMemAggregateCache` field + `aggregate_cache()` / `aggregate_cache_stats()` accessors. `mark_dirty_from_cell_write` calls `invalidate_at(s, r, c)` before fanning out dirty propagation — entries whose range contains the cell are dropped (precision-exact).  
   - `WorkbookRuntime::set_formula` routes through `eval_scalar_with_cache` (using session cache when attached). `recompute_dirty` uses `try_recompute_with_aggregate_cache`.  
   - The legacy `eval_scalar_with_registry` + `recompute_all` paths use `NoAggregateCache` (no behavior change without a session).  
   16 new tests (7 aggregate_cache unit + 4 AGG-3-01..04 acceptance + 3 NAG-* updated for actual eval + 2 read_range correctness). ql-exec at 311 (was 295). Workspace at 926 (was 915).  
   Notes: V1 caches only single-`AggregateNameRef`-arg calls. Multi-range and mixed-type args (`SUM(A, 5)`, `SUM(A, B)`) fall back to no-cache. Phase 4.7 (array formulas) revisits.  
   Effort: 5-8 days (actual: ~1 day; substrate from 3.5 overlay split made range reads clean).

7. **3.7 Volatile Function Invalidation** ✅ SHIPPED 2026-05-12 (W5-40)  
   Model NOW/RAND/RANDBETWEEN and later volatile functions as graph roots invalidated by recompute cycle, edit, or explicit recalc mode. Add deterministic test mode.  
   References: `.references/formualizer/crates/formualizer-eval/src/rng.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/tests/volatile_rng.rs`; `.references/ironcalc/base/src/functions/math_and_trigonometry/random.rs`.  
   Acceptance: VOL-3-01 ✅ `mark_volatile_dirty` + `recompute_dirty` produces a new RAND() value (`vol_3_01_volatile_formulas_recompute_when_requested`); VOL-3-02 ✅ non-volatile dependents update when volatile changes (`vol_3_02_nonvolatile_dependents_update_when_volatile_changes`); VOL-3-03 ✅ seeded RNG produces deterministic RAND() sequence (`vol_3_03_seeded_rng_produces_deterministic_rand_sequence`).  
   Shipped:  
   - New `ql-functions::volatile` module: NOW, TODAY, RAND, RANDBETWEEN. xorshift64 PRNG with thread-local state — no `rand` crate dep (Phase 0 pin-guard rule). Default seeds from SystemTime nanos; tests override via `set_test_rng_seed`. Excel epoch (1899-12-30) used for NOW/TODAY serial dates; `set_test_now_secs` pins for tests.  
   - All 4 registered in `default_registry`. Registry count now 30 (was 26).  
   - `CalcgraphSession::mark_volatile_dirty()` — adds all volatile formulas to the dirty set AND calls `mark_dirty_from_cell_write` for each to fan out the reverse-dep BFS (VOL-3-02 wiring; downstream chains pick up the new value). Returns count of marked formulas.  
   - `CalcgraphSession::volatile_count()` for observability.  
   - The Phase 3.2 substrate (`is_volatile_function` whitelist + `volatile_formulas` set populated during dep extraction) was already in place; 3.7 just wires the tick.  
   - Public `ql_functions::{set_test_rng_seed, set_test_now_secs, clear_test_overrides}` for engine + IDE test fixtures.  
   13 new tests (9 volatile unit + 3 VOL-3-01..03 acceptance + 1 zero-volatile-noop). ql-exec at 315, ql-functions at 72, workspace at 939.  
   Notes: RANDARRAY / INDIRECT / OFFSET / INFO / CELL still deferred to Phase 4.3 (function library expansion). NOW/TODAY date arithmetic is approximate (Excel 1900 leap-year quirk not modeled); Phase 4.5 (date/time + format) pins exact semantics.  
   Effort: 2-4 days (actual: ~1 day; substrate from 3.2 made this small).

8. **3.8 Value-Equality Short-Circuit** ✅ SHIPPED 2026-05-12 (W5-41)  
   If a recomputed value is equal to the previous visible value, do not dirty downstream dependents beyond what is already required. Equality must respect Excel errors, blanks, numbers, text, bools, and dates.  
   References: `.references/hyperformula/src/DependencyGraph/TopSort.ts`; `.references/hyperformula/src/interpreter/InterpreterValue.ts`; `crates/ql-types/src/value.rs`.  
   Acceptance: VEQ-3-01 ✅ unchanged upstream suppresses downstream recompute (`veq_3_01_unchanged_upstream_suppresses_downstream_recompute`); VEQ-3-02 ✅ error equality is correct (`veq_3_02_error_equality_suppresses_downstream`); VEQ-3-03 ✅ profile records skipped vertices via `RecomputeResult.skipped_value_equality` (`veq_3_03_profile_records_skipped_vertices`).  
   Shipped:  
   - `RecomputeResult.skipped_value_equality: usize` — new public field counting how many dirty formulas were skipped via VEQ. Always 0 on `recompute_all` (legacy path).  
   - `recompute_dirty` rewrite: snapshot prior values for all sched nodes; process in topo order; for each node, decide if it needs eval (volatile → yes, range deps → yes, top-level dirty → yes, has-changed-upstream → yes, otherwise → SKIP). After eval, compare new vs prior. If equal, suppress the computed-overlay write and don't mark as changed; downstream formulas observe "no changed deps" and skip too.  
   - Cycled nodes apply VEQ: a pre-existing `#CIRC!` stays `#CIRC!`; skip the write but count.  
   - Volatile formulas (NOW, RAND, etc.) bypass VEQ — they always re-evaluate (Phase 3.7 invariant preserved via `session.is_volatile(node)` check).  
   - Aggregate-cache hits (Phase 3.6) interact correctly: a cached aggregate result that matches prior still counts as a VEQ skip when the formula's eval returns it.  
   4 new tests (VEQ-3-01..03 + volatile-bypass regression). ql-exec at 319 (was 315). Workspace at 943 (was 939).  
   Notes: V1 doesn't handle range-dep formulas with VEQ — they always re-evaluate. The Phase 3.6 aggregate cache already provides O(1) re-eval for unchanged ranges, so this is a small cost.  
   Effort: 2-4 days (actual: ~1 day; the substrate from 3.3 BFS + 3.4 schedule_dirty + 3.6 prior-comparison-via-overlay made this small).

9. **3.9 SIMD Region Through Graph Runtime** ✅ SHIPPED 2026-05-12 (W5-42, V1)  
   Ensure region-style lowering and direct Arrow kernels are invoked from the graph scheduler rather than separate bench-only paths.  
   References: `.references/formualizer/crates/formualizer-eval/src/stripes.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/range_view.rs`; `crates/ql-exec/src/{lower,simd}.rs`.  
   Acceptance: SIMD-3-01 ✅ OG-02 `=A*2` pattern still classifies to `SimdShape::MulScalar`; `scripts/check-multiversion-clones.sh` confirms the multiversion clones are present in `mul_scalar` (`simd_3_01_og02_pattern_classifies_to_mul_scalar`); SIMD-3-02 ✅ `Operator::Div` returns `SimdShape::NotApplicable` so `10 / 0` emits Excel-canon `#DIV/0!` not `#NUM!` (`simd_3_02_division_falls_back_to_scalar`); SIMD-3-03 ✅ `RecomputeResult.simd_classified` counter exposes SIMD-eligibility of dirty formulas; legacy `recompute_all` is always 0 (`simd_3_03_profile_records_simd_eligible_formulas`).  
   Shipped:  
   - `RecomputeResult.simd_classified: usize` — new public field, parallel to `skipped_value_equality`. Counts dirty formulas whose `lower::classify` returns an applicable `SimdShape`.  
   - `WorkbookRuntime::try_recompute_with_simd_profile` — slightly-expanded helper that returns `(Value, bool)` where the bool is the SIMD-eligibility flag. `try_recompute_with_aggregate_cache` is now a thin wrapper that discards the flag.  
   - V1 observability only — actual bulk SIMD dispatch via `simd::*` kernels remains on the bench / FormulaRegion path. The Phase 4.7+ array-formula / FormulaRegion binder lands the real batching. The graph scheduler's awareness of SIMD-eligibility is the V1 contribution: the IDE / profile reader can now see WHERE region optimization would pay off.  
   3 new acceptance tests + 1 regression. ql-exec at 322 (was 319). Workspace at 946 (was 943).  
   Notes: this V1 is intentionally observability-focused. The MASTER-PLAN's 3-6 day effort estimate covered the full FormulaRegion-binder + per-region batched dispatch — that's structurally a Phase 4 task (depends on the array-formula binder + region detection at write time). Phase 3.10 megaudit will evaluate whether V1 is sufficient or whether a richer V1.1 is needed before Phase 4.  
   Effort: 3-6 days (actual V1: ~0.5 day; the substrate from Phase 0 W4-2/3 and the bench gate already validated the kernel-level SIMD).

10. **3.10 Phase 3 Megaudit** ✅ SHIPPED 2026-05-12 (W5-43)  
    Independent audit of graph correctness, scheduler cycles, storage overlays, dirty propagation, aggregate invalidation, and perf regressions.  
    Acceptance: A3-01 ✅ all 7 gates green pre- and post-audit; A3-02 ✅ dependency-chain correctness locked (with H1/H3/H4 documented as Phase 4 carryovers — root cause: Phase 0 append-only graph contract); A3-03 ✅ `crates/ql-exec/benches/a3_10k_dirty_recompute.rs` checked in (chain + idempotent edit shapes); A3-04 ⚠️ documented exception (946 tests vs ~1724 target — Phase 3 was substrate-completion, not new-feature; 84 net tests cover every declared acceptance gate without redundancy; broad expansion lands Phase 4 with function library + array formulas + date/time + xlsx).  
    Audit dispatched: Codex (gpt-5-codex via `codex exec`) reviewed Phase 3.1–3.9 commits independently. Findings: 4 HIGH (H1 range-deps-not-edges, H2 set_name not transitive, H3/H4 append-only-graph rebind staleness), 4 MEDIUM, 3 LOW, 6 test gaps. **Closed in audit commit:** H2 (BFS fanout fix + regression test `h2_set_name_propagates_dirty_transitively`), L1 (architecture doc rewrite), L2 (GAP-G-01 re-classified from performance-only to correctness), T4 (set_name regression test). **Deferred to Phase 4 with documented gaps:** H1 → GAP-G-03 (range-as-scheduler-edge), H3+H4 → GAP-G-01 (now correctness; needs delta-edge graph), M1 → GAP-R-08 (volatile-dependent recompute Excel-canon), M3 → GAP-S-06 (load bounds for formula-only cells). Full audit report: `docs/audits/2026-05-12-phase-3-megaudit.md`.  
    Effort: 3-5 days (actual: ~0.5 day including Codex dispatch + audit closure fixes).

**Audit Checkpoints**

- Internal checkpoint after 3.4 before overlay/cache work.
- Megaudit after 3.9. This is mandatory because Phase 3 changes the engine spine.

**IDE Proof Points**

- IDE edits must trigger incremental recompute.
- Diagnostics must identify cycles and dirty recompute failures.
- Formula bar must show stable values after dependency-chain edits.

**Exit Criteria**

- No map-order recompute remains in product paths.
- Runtime and fast engine are one graph-driven engine.
- Range aggregates have first usable cache.
- Computed/user overlay separation exists.
- Volatile invalidation is explicit.

**Documentation Deliverables**

- `docs/phase3/entry-plan.md`.
- `docs/phase3/exit-packet.md`.
- `docs/architecture/calcgraph-runtime.md`.
- Updated reference reading log entries for every borrowed pattern.

## Phase 4 - Excel Coverage

**Purpose:** Build broad Excel compatibility: parser breadth, function library, coercion/error matrices, dates/times, formatting, arrays/spills, tables, cross-sheet refs, named aggregate contexts, localization, and xlsx import/export.

**Entry State Required**

- Phase 3 graph runtime is shipped.
- Aggregate, dirty, and volatile machinery exist.
- **GAP-G-01 + GAP-G-03 SHIPPED (W5-50, 2026-05-13).** Decision recorded in `docs/architecture/2026-05-13-graph-storage-decision.md` (W5-49) and implemented W5-50: Option A — `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula` + `StripeIndex::clear_for_formula` backed by `formula_to_stripe_keys` reverse index, wired into `extract_and_register_deps`. Option C — `topo::schedule_with_supplemental` accepts a HashMap of temp adjacency; `CalcgraphSession::build_range_supplemental` constructs F→G edges for dirty-formula pairs inside ranges. FormulaRegion binder (Option B) still deferred to Phase 4.7. Phase 4.3 V2 (SUMIF/COUNTIF/lookup family) is **now unblocked**. Tests: +35 vs Phase 3 exit (981 → 1016 workspace).

**Dependencies**

- Array formulas, spills, structured references, xlsx formula load, and cross-sheet recalculation depend on Phase 3 graph integration.
- IronCalc deep-read is mandatory at Phase 4 start.
- ~~Phase 4.3 V2 is gated on GAP-G-01 (Option A) + GAP-G-03 (small Option C).~~ **Gate cleared W5-50.** Phase 4.7 (array formulas) consumes Option A's revocation API as well.

**Sub-items**

1. **4.1 IronCalc Parser Deep-Read And Parser Gap Matrix** ✅ SHIPPED 2026-05-12 (W5-44)  
   Read IronCalc parser and lexer in the deferred order, then write a Quantbook parser gap matrix.  
   References: `.references/ironcalc/base/src/expressions/parser/mod.rs`; `.references/ironcalc/base/src/expressions/lexer/mod.rs`; `.references/ironcalc/base/src/expressions/parser/static_analysis.rs`; `.references/ironcalc/base/src/expressions/parser/stringify.rs`; `.references/ironcalc/base/src/expressions/parser/move_formula.rs`.  
   Acceptance: PAR-4-01 ✅ gap matrix checked in at `docs/parser/ironcalc-deep-read.md`; PAR-4-02 ✅ parser expansion (4.6/4.7/4.8/4.9 lexer + AST work) is now formally unlocked; PAR-4-03 ✅ license + provenance documented (IronCalc MIT + Apache-2.0; reference-only policy).  
   Shipped:  
   - Full token-kind gap analysis (IronCalc has 11 tokens we don't; we have a few simplifications IronCalc lacks).  
   - Full AST-node gap analysis (IronCalc has 10 node variants we don't, mapped to Phase 4.6/4.7/4.8/4.9 / post-v1 buckets).  
   - Feature parity table covering A1/R1C1/cross-sheet/array/structured/LAMBDA/implicit-intersection/spill/localization/move-formula.  
   - Architectural recommendations: adopt IronCalc's precedence tower for Phase 4.7; locale threading pattern for 4.9; recoverable parse errors via AST `ParseError` nodes for 4.4 error matrix; move-formula as separate tree-walk pass for Phase 5+ copy/paste.  
   - Sequencing recommendation: collapse 4.6+4.7+4.8 lexer work into one token-set expansion sprint to avoid three back-to-back lexer churns.  
   - Surfaced GAP-G-01 + GAP-G-03 (Phase 3.10 megaudit carryovers) as Phase 4 entry decisions — array formulas + function library expansion both rebind formulas at scale; the append-only graph fix needs to happen before 4.3 or be a known limitation gated by 4.12 megaudit.  
   Effort: 2-4 days (actual: ~0.5 day; Explore subagent did the IronCalc survey).

2. **4.2 Excel Compatibility Matrix Harness** ✅ SHIPPED 2026-05-12 (W5-45); doc honesty patched W5-48  
   Create a checked-in matrix for functions, operators, coercions, errors, arrays, tables, date systems, localization, and xlsx import/export.  
   References: `.references/formualizer/benchmarks/function_matrix.yaml` (taxonomy ref only — not directly applicable; formualizer's matrix is benchmark-scenario claim-safety, not per-function compat); `.references/ironcalc/base/src/test/` (used implicitly via Phase 4.1 gap matrix).  
   Acceptance:  
   - ECM-4-01 ✅ matrix exists at `docs/compat/excel-matrix.md`.  
   - ECM-4-02 ⚠️ **PARTIAL** (revised W5-48 per Codex deep-audit): each function row carries Status + Tests + Phase + Notes; the CATEGORY for each function is the `###` section header it lives under (Aggregates/Statistical, Logical, Math&Trig, Text, Date&Time, Lookup&Reference, Information, Financial, Engineering, Database, Reserved) rather than a per-row column. ~52 rows have empty/short Notes — full per-row parity-note expansion is the documented Phase 4.3+ follow-up. The original ECM-4-02 prose was rewritten to match the actual schema.  
   - ECM-4-03 ✅ `scripts/report-compat-coverage.sh` parses the matrix and emits human-readable + JSON output with per-category breakdown and headline `coverage=NN%`.  
   Shipped baseline: 217 rows (post-W5-46 + W5-48 status revisions: 70 ✅ + 16 ⚠️ + 1 🔄 + 130 ❌) ≈ **40% coverage**.  
   Effort: 2-3 days (actual: ~0.5 day for V1 + 0.1 day for audit closure).

3. **4.3 Function Library Expansion Wave 1 - Core 100** 🔄 IN PROGRESS (V1 batch shipped 2026-05-13, W5-46; FN4-02 backfill W5-48)  
   Implement high-use math, logical, text, lookup, statistical, date/time, and information functions. Include metadata for volatility, laziness, array behavior, and argument coercion.  
   **V2 prerequisites (W5-49 decision; SHIPPED W5-50 + W5-52):**
   - GAP-G-01 + GAP-G-03 (graph correctness): SHIPPED. W5-50 wired revocation into the rebind path; W5-52 (mega-audit closure) extended it to the clear path that W5-50 missed. See `docs/architecture/2026-05-13-graph-storage-decision.md`.
   - ~~**GAP-F-05 (function-dispatch signature)**~~ **SHIPPED W5-53.** Parallel `RangeAwareFn = fn(&[FnArg]) -> Value` table added to `FunctionRegistry`; `enum FnArg { Scalar(Value), Range(Vec<Value>) }`. Eval-side dispatch checks the range-aware table first. SUMIF + COUNTIF shipped in the same commit as the first range-aware functions. The full range-aware family (SUMIFS / AVERAGEIF / SUMPRODUCT / VLOOKUP / HLOOKUP / MATCH / INDEX / CHOOSE) is now safely unblocked.
   - Scalar-only V2 batches (W5-51 trig) and range-aware V2 batches (W5-53 SUMIF/COUNTIF) both ship under the same Phase 4.3 V2 banner. Remaining V2 work: text family (LEFT/RIGHT/MID/FIND/SEARCH/SUBSTITUTE/REPLACE), more math (CEILING/FLOOR/GCD/LCM), hyperbolic trig, stats range-aware (MEDIAN/MODE/LARGE/SMALL/RANK), and the SUMIFS/lookup family.  
   References: `.references/ironcalc/base/src/functions/mod.rs`; `.references/ironcalc/base/src/functions/math_and_trigonometry/`; `.references/ironcalc/base/src/functions/statistical/`; `.references/formualizer/crates/formualizer-eval/src/function_registry.rs`.  
   Acceptance:  
   - FN4-01 ✅ **CLOSED W5-58** — registry at 102 entries (30 pre-W5-46 → 52 V1 → 59 W5-51 trig → 61 W5-53 SUMIF/COUNTIF → 66 W5-54 lookup → 71 W5-55 IFS + SUMPRODUCT → 81 W5-56 text wave 2 → 95 W5-57 math + hyperbolic → 102 W5-58 stats family). FN4-01 acceptance: 100-function target met.  
   - FN4-02 ✅ (after W5-48 backfill) each V1-batch function now has positive + error + coercion + arity tests. Initial V1 commit (W5-46) had only positive tests for most fns; Codex deep-audit H5 flagged the gap; W5-48 closure adds 9 dedicated H5 backfill tests (ROUNDDOWN/TRUNC/SIGN/EXP/LOG10/DEGREES+RADIANS/UPPER+LOWER/TRIM/LEN-unicode).  
   - FN4-03 ❌ IF/IFERROR lazy eval still deferred.  
   - FN4-04 ✅ matrix updated; coverage 32% → 40%; UPPER/LOWER reclassified ⚠️ partial (Unicode-default mapping diverges from Excel for ß and other locale-sensitive chars); ROUNDUP/ROUNDDOWN reclassified ⚠️ partial (binary-float edge cases vs Excel's 15-digit display rounding); LEN annotated as known scalar-vs-UTF-16 divergence.  
   V1 batch shipped (22 functions): ROUNDUP, ROUNDDOWN, TRUNC, SIGN, EXP, LN, LOG, LOG10, PI, DEGREES, RADIANS, LEN, UPPER, LOWER, TRIM, ISNUMBER, ISTEXT, ISBLANK, ISLOGICAL, ISERROR, ISNA, ISERR. All scalar (per-cell, no range deps beyond what 3.6 already provides). Excel-canon error propagation; W5-48 fixed M7 (DEGREES/RADIANS now sanitize output via `sanitize_f64` so Inf surfaces as `#NUM!`).  
   FN4-01 closure complete (W5-58). Shipped: trig W5-51, SUMIF/COUNTIF W5-53, lookup family W5-54, IFS family + SUMPRODUCT W5-55, text wave 2 W5-56, math completion + hyperbolic W5-57, stats family W5-58. **Phase 4.3 polish wave 1 shipped W5-61 + closed W5-62**: wildcards in SUMIF/COUNTIF/SUMIFS/AVERAGEIF/SEARCH (`?`, `*`, `~` escape; text-cell-only), CONCAT (range-aware, 32K cap), PROPER, CLEAN, CEILING.MATH, FLOOR.MATH, RANK.AVG. Polish remaining (deferred to wave 2 / Phase 4.7+): MODE.MULT (needs spill), CEILING.PRECISE / FLOOR.PRECISE, FN4-03 lazy IF/IFERROR.  
   Known divergences from Excel canon (still open at Phase 4.9 close):  
   - UPPER/LOWER: Rust's `to_uppercase`/`to_lowercase` use Unicode default mapping (ß → SS); Excel preserves case-sensitive locale rules. Originally anticipated for Phase 4.9 — that phase shipped R1C1+locale-separators+`@` but NOT locale-sensitive case mapping; awaiting a future Phase.  
   - LEN: Rust scalar count (`.chars().count()`); Excel UTF-16 code unit count. Matches for ASCII/BMP; diverges for emoji ZWJ sequences. Originally anticipated for Phase 4.9 — that phase did NOT address UTF-16 string semantics; awaiting a future Phase.  
   - ROUNDUP/ROUNDDOWN: binary-float edges (`0.1 + 0.2` rounds up to `0.4` not `0.3`); Phase 4.5 number formats + decimal-aware rounding revisits.  
   Effort: 2-3 weeks (V1 batch + audit closure: ~0.6 day; remaining: 1-2 weeks).

4. **4.4 Coercion And Error Semantics Matrix**  
   Centralize coercion rules and error precedence. Lock binary op behavior, function argument coercion, blank handling, text-to-number, and date serial behavior.  
   **Status:**
   - **4.4 design (W5-63 ✅)** — `docs/architecture/2026-05-13-coercion-matrix.md` (Codex-reviewed, 3 HIGH + 4 MEDIUM + 3 LOW findings synthesized).
   - **4.4.A helper migration (W5-64 ✅)** — `ql-types::coercion` gained `to_text_for_arg`, `to_int_arg`, `to_number_strict_skip_blank`, `format_number_for_arg` + NaN/Inf policy on text/display.
   - **4.4.B matrix-as-tests (W5-65 ✅)** — 4 new integration test files (89 tests) pinning the §3.1/§3.3/§3.4 matrices + registry coverage guardrail.
   - **4.4.C error-matrix doc (W5-66 ✅)** — `docs/compat/error-matrix.md` distillation.
   - **4.4 mega-audit closure (W5-67 ✅)** — Codex + Sonnet parallel mega-audit. 2 HIGH (COUNT canon mismatch → GAP-F-06 + V1 divergence relabel; error-matrix overclaim → honest framing) + 7 MEDIUM + 3 LOW all addressed.  
   References: `.references/ironcalc/base/src/cast.rs`; `.references/ironcalc/base/src/calc_result.rs`; `.references/formualizer/crates/formualizer-eval/src/coercion.rs`; `.references/hyperformula/src/interpreter/InterpreterValue.ts`.  
   Acceptance: COER-4-01 matrix checked in ✅; COER-4-02 arithmetic, comparison, aggregate, logical, and text coercion cases covered ✅ (W5-65 tests); COER-4-03 no silent fallback for unsupported variants ✅ (W5-64 NaN/Inf policy + matrix-tests).  
   Effort spent: ~3 sessions implementation. Mega-audit cycle pending.

5. **4.5 Dates, Times, Number Formats — ✅ FULLY SHIPPED 2026-05-13 (W5-69 → W5-84)**  
   Implement serial date systems, time arithmetic, display formatting, parse formatted numbers, and locale-sensitive format tokens.  
   **Design doc (Codex-reviewed W5-68):** `docs/architecture/2026-05-13-dates-times-formats.md` — 6 sub-phases (4.5.A.0 EvalContext tier, 4.5.A epoch+serial, 4.5.B 18-fn V1 wave, 4.5.C 7-fn V2 wave, 4.5.D format parser + sparse overlay + op-log, 4.5.E TEXT() + locale stubs). 4 HIGH + 8 MEDIUM + 5 LOW Codex findings synthesized into the design.  
   **4.5.D companion mini-spec (W5-77):** `docs/architecture/2026-05-13-format-string-grammar.md` — EBNF + token table + section semantics + V1/V2 split + IronCalc-divergence catalog + error categories. Lands BEFORE parser implementation per design doc § 13 (W5-49 pattern).  
   **Sub-phase status:**
   - **4.5.A.0** ✅ SHIPPED W5-69 — `EvalContext` + `ContextAwareFn` registry tier.
   - **4.5.A** ✅ SHIPPED W5-70/W5-71 — `ql-types::date` module + `Workbook::date_system` + `.qbook` schema v3 migration.
   - **4.5.B** ✅ SHIPPED W5-72/W5-73/W5-74 — V1 date/time function wave (18/18: DATE/YEAR/MONTH/DAY/HOUR/MINUTE/SECOND/TIME/DATEVALUE/TIMEVALUE/NOW/TODAY/WEEKDAY/EOMONTH/EDATE/DAYS/NETWORKDAYS/WORKDAY/YEARFRAC).
   - **4.5.C** ✅ SHIPPED W5-75 — V2 wave 4/6 (DATEDIF/DAYS360/WEEKNUM/ISOWEEKNUM; NETWORKDAYS.INTL + WORKDAY.INTL deferred to tier-4 build).
   - **4.5.D** ✅ SHIPPED W5-77a → W5-82 — format parser + renderer + FormatTable + sparse overlay + op-log + `.qbook` schema v4 + WorkbookRuntime wrappers + `read_display`.
   - **4.5.E** ✅ SHIPPED W5-83 — `TEXT(value, format_string)` formula function.
   - **Mid-arc mega-audit** ✅ W5-76 — closed 3 HIGH + 5 MEDIUM on the V1+V2 date wave.
   - **Closing mega-audit** ✅ W5-84 — closed 1 HIGH (fraction `?/?` V2 rejection missing) + 3 MEDIUM (`walk_for_anchor` DateM stop, `.qbook` overlay-id validation, producer-replay equivalence format coverage) + filed GAP-F-12 (format_cache staleness) + GAP-F-13 (built-in table subset for xlsx).  
   References: `.references/ironcalc/base/src/formatter/`; `.references/ironcalc/base/src/functions/date_and_time.rs`; `.references/formualizer/crates/formualizer-workbook/tests/calamine/dates.rs`.  
   Acceptance: DTF-4-01 1900/1904 policy explicit; DTF-4-02 date/time functions match matrix; **DTF-4-03 re-scoped to "format parser has en-US fully populated + extension point for locale; en/de/fr behavior tests move to Phase 4.9"** (Codex HIGH 3) — **Phase 4.9 (W5-138 → W5-152, 2026-05-15) shipped R1C1 + locale separators + `@` but did NOT add format-string locale tests; those remain deferred to a future Phase**; DTF-4-04 storage distinguishes value from display format via sparse format overlay + workbook FormatTable.  
   Effort: ~6-8 sessions implementation + 1 mega-audit per the design doc § 8 (Codex MEDIUM 3 re-estimate; Phase 4.4 reference: estimated 2.5 sessions, took 5).

6. **4.6 Cross-Sheet References And Sheet-Scoped Names** ✅ **FULLY SHIPPED** (W5-85 → W5-93, 2026-05-14)
   Extended AST/binder/runtime to support `Sheet1!A1`, quoted sheet names, sheet rename with formula-text rewrite, and sheet-scoped names. Sub-phases:
   - 4.6.AA (W5-86) — sheet registry + canonicalizer (`Workbook::sheet_id_by_name`, `canonical_sheet_name`, `validate_sheet_name`).
   - 4.6.A (W5-87 → W5-89) — `SheetRef::{Current, Name, Id}` AST migration + lexer Bang/SheetName/QuotedSheetName tokens + parser/printer cross-sheet round-trip.
   - 4.6.B (W5-90) — `SheetResolver` trait + `bind_with_names_and_sheets` + `BindError::UnknownSheet`. **XS-4-01 closed.**
   - 4.6.C (W5-91) — `WorkbookRuntime::rename_sheet` + formula-text rewrite + `Op::RenameSheet` with 3-case replay reconciliation.
   - 4.6.D (W5-92) — sheet-scoped names: `Sheet::scoped_names` + `NameLookup for Workbook` two-tier chain + `Op::SetName { scope, .. }` + schema v5 `NamedEntry.scope`. **XS-4-03 closed.**
   - 4.6.E (W5-93) — closing mega-audit (Codex + Sonnet parallel). Closed 2 HIGH (sheet-name validation at storage/runtime/replay; PlanCache invalidation on sheet-scoped name change) + 3 MEDIUM (printer doc, producer-replay scope coverage, doc rot) + filed GAP-B-06 (`NamedTarget::Formula` rewrite on rename), GAP-B-07 (`A1!B2` lexer accepts), GAP-B-08 (resolver-aware print).
   References: `.references/ironcalc/base/src/expressions/lexer/ranges.rs`; `.references/ironcalc/base/src/expressions/parser/tests/test_ranges.rs`; `.references/hyperformula/src/DependencyGraph/SheetMapping.ts`; `.references/formualizer/crates/formualizer-eval/src/engine/graph/sheets.rs`.  
   Acceptance: XS-4-01 ✅ cross-sheet cell refs parse, print, bind, and recompute; XS-4-02 ✅ quoted names work; XS-4-03 ✅ sheet-scoped names resolve before workbook-scoped names; XS-4-04 ✅ op-log preserves sheet identity (xlsx is Phase 4.11). **3D references explicit non-goal** per design doc § 10.5.
   Effort actual: 8 commits W5-86→W5-92 plus W5-93 closure ≈ 1 week as planned. Design doc: `docs/architecture/2026-05-13-cross-sheet-references.md`. Audit prompt + Codex/Sonnet outputs in `docs/audits/2026-05-14-phase-4.6-closing-megaudit-*`.

7. **4.7 Array Formulas And Dynamic Spills**  
   Implement array literals, dynamic-array functions, spill ranges, spill blocking, spill invalidation, and computed-overlay writeback.  
   References: `.references/ironcalc/base/src/expressions/parser/tests/test_arrays.rs`; `.references/ironcalc/base/src/test/array_formulas/`; `.references/formualizer/crates/formualizer-eval/src/engine/spill.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/tests/spill_*.rs`; `.references/hyperformula/src/DependencyGraph/ArrayMapping.ts`.  
   Acceptance: ARR-4-01 array literals parse and evaluate; ARR-4-02 spill writes computed overlay only; ARR-4-03 blocked spills return the right error; ARR-4-04 dynamic spill resizing invalidates dependents.  
   Effort: 2-3 weeks.

8. **4.8 Structured References And Tables**  
   Add table metadata to storage, parser/binder support for `Table[Column]`, totals/special specifiers, and graph dependencies for table ranges.  
   References: `.references/ironcalc/base/src/expressions/lexer/structured_references.rs`; `.references/ironcalc/base/src/expressions/parser/tests/test_tables.rs`; `.references/formualizer/crates/formualizer-parse/src/structured_ref.rs`; `.references/formualizer/crates/formualizer-workbook/tests/umya/tables.rs`.  
   Acceptance: TBL-4-01 table refs parse/print; TBL-4-02 column insert/delete updates refs; TBL-4-03 table aggregate dependencies use range graph; TBL-4-04 xlsx import creates tables.  
   Effort: 1-2 weeks.  
   **Status (2026-05-16): SHIPPED.** Phase 4.8 core shipped 2026-05-15 at `6717ae7fe9f` (closing megaudit SHIP-READY at W5-129); the 4.8.G.3 calcgraph-hook polish wave (originally marked OPTIONAL) shipped 2026-05-15 → 2026-05-16 at `3ff9c1501cc` (W5-159) after the W5-150 / W5-155 audit cycles demonstrated the hooks were load-bearing for the design § 12.4 contract ("dropped-table refs emit `#NAME?`"). Six commits closed 4.8.G.3: W5-154 `table_to_formulas` reverse index + `on_table_drop` hook; W5-155 wired drop_table; W5-156 HIGH-1 plan-cache flush + HIGH-2 bind-error → `#NAME?` mapping (3-way audited); W5-157 `on_table_rename` with `deps.tables` Arc substitution + re-key; W5-158 coarse `on_column_rename`; W5-159 `on_table_resize` + runtime-side `reextract_table_readers` for range-stripe refresh. Acceptance: TBL-4-01 ✅ parser/printer/binder coverage exhaustive; TBL-4-02 ✅ column rename/resize hooks + reverse index ship; TBL-4-03 ✅ range graph + stripe refresh after resize; TBL-4-04 ⏳ deferred to Phase 4.11 xlsx I/O. 4.8.N soft-fail (accept-text-then-error-cell) remains DEFERRED — backwards-incompatible. W5-160 plan-cache `table_gen` polish remains OPTIONAL (current `plan_cache.clear()` is correct; targeted `table_gen` would only marginally improve memory).

9. **4.9 R1C1, Localization, Implicit Intersection**  
   Add mode-aware parsing/printing for R1C1, localized separators/function names where required, and implicit intersection semantics.  
   References: `.references/ironcalc/base/src/expressions/lexer/test/test_locale.rs`; `.references/ironcalc/base/src/expressions/parser/tests/test_locales.rs`; `.references/ironcalc/base/src/implicit_intersection.rs`; `.references/ironcalc/base/src/expressions/parser/tests/test_implicit_intersection.rs`; `.references/hyperformula/src/parser/addressRepresentationConverters.ts`.  
   Acceptance: LOC-4-01 R1C1 parser/printer round-trips; LOC-4-02 localized separators covered; LOC-4-03 implicit intersection added where Excel requires it; LOC-4-04 IDE can toggle formula display mode.  
   Effort: 1-2 weeks (actual: ~2 days).  
   **Status (2026-05-15): SHIPPED triple-confirmed at `6523001b837` (W5-152).** All 15 sub-phases shipped (AA design + A types + B.1-.4 lexer + C parser+binder + D printer + F locale-printer + G `@`-parser-printer + H `@`-binder + I persistence v6→v7 + J op-log + K runtime+canonical + L round-trip + M coverage matrix + N polish + O closing megaudit). Acceptance closures: LOC-4-01 R1C1 round-trips pinned at lex/parse/bind/print stages; LOC-4-02 EN/DE/FR separators pinned by 30-cell coverage matrix; LOC-4-03 `@` operator + design § 3.3 9-rule narrowing implemented at bind time; LOC-4-04 `WorkbookRuntime::set_reference_mode` + `set_locale` APIs available. Closing megaudit (three-way: self-review + Sonnet + Codex async) found 1 HIGH (PlanCache × `@<range>` cell collision — fixed W5-150) + 2 MEDIUM (W5-151) + 3 LOW (W5-152). +175 net tests (2443 → 2618). Function-name localization remained OUT-of-scope per LOC-4-02 (separators only). Known gaps documented: rule 7 (array-returning function under `@` returns `#CALC!` per existing 4.7.G limit) → cell-boundary spill rewiring; cross-sheet structured refs (`Sheet1.Sales[Qty]`) → later Phase. Full audit trail in `docs/audits/2026-05-15-phase-4.9-*.md`.

10. **4.10 Function Library Expansion Wave 2 - V1 260**  
    Finish the v1 function target. Defer only with explicit product sign-off and matrix entries.  
    References: `.references/ironcalc/base/src/functions/`; `.references/formualizer/benchmarks/function_matrix.yaml`; `.references/hyperformula/src/interpreter/FunctionRegistry.ts`.  
    Acceptance: FN4-260-01 roughly 260 target functions implemented or explicitly cut; FN4-260-02 every implemented function has matrix-backed tests; FN4-260-03 unsupported functions produce visible errors.  
    Effort: 3-5 weeks.

    **Status (2026-05-17 → 2026-05-18): SHIPPED at 260/260 registered fns** through MASTER-PLAN marker `5d117724f27` (impl HEAD `517bcab08b7` for W5-D-12.1 audit transcripts; subsequent megaudit closure W5-D-13.1 lands on top). Path: W5-D-1..W5-D-7 Wave 3 distributions (+38 → 238), W5-D-8 BIT* (+5 → 243), W5-D-9 base conversion (+6 → 249), W5-D-10 ERF/ERFC family (+4 → 253), W5-D-11 PERCENTILE/QUARTILE (+6 → 259), W5-D-12 SUBTOTAL (+1 → **260** — V1-260 hit). 12 closeout-arc batches with ship+audit commit pairs each (24 audit transcript files: 1 Codex + 1 Opus per batch). Matrix coverage 82% post-W5-D-13.1 megaudit closure per `scripts/report-compat-coverage.sh`. Acceptance: FN4-260-01 ✅ 260 registered; FN4-260-02 ✅ every fn has matrix-backed tests + coverage-discipline EXPLICITLY_DEFERRED entry; FN4-260-03 ✅ unregistered fns produce `#NAME?`. Per-batch audit-discipline rule (parallel Codex + separate-Opus) caught Codex 1H/2M/7L + Opus 5H/10M/20L across the 5 V1-260 closeout batches; all closed in-commit per the `.1` convention. **W5-D-13.1 phase megaudit** (2026-05-18, parallel Codex + Opus + self) caught 6 ADDITIONAL HIGH issues invisible at the per-batch level: 28 range-aware fns missing from `is_aggregate_function` binder admission (extending the W5-D-12 SUBTOTAL-only fix to the whole family), 3 fns unreachable from formula source text (ATAN2/SUMXMY2/DAYS360 — lexer letters>3+digit gap), `GAMMA.INV` finite-subnormal-scale panic (incomplete W5-D-5.1 closure), W5-D-12 closure shipped without recommended named-range e2e test, audit-discipline systemic blind spot for dispatch-path coverage, 21 fns in Date/Time + TRANSPOSE marked ❌ but registered (matrix-registry drift). All 6 HIGHs closed in W5-D-13.1. Known follow-ups (deferred, NOT regressions): (a) literal range refs in `AggregateArg` context (`SUM(A1:A10)`, `CORREL(A1:A4, B1:B4)`) remain unbindable — pre-existing engine-wide gap at `plan.rs:706-731` and `plan.rs:380-383`, affects EVERY aggregate not just Phase 4.10 fns; named-range and scalar-args paths work today via W5-D-13.1; (b) Batch E remainders LOOKUP vector form + LEFTB/RIGHTB/MIDB/LENB/FINDB/SEARCHB byte-length variants. Full audit trail: 24 per-batch transcripts at `docs/audits/2026-05-17-w5-d-*.md` + 3 megaudit transcripts at `docs/audits/2026-05-17-phase-4-10-megaudit-{codex,opus,self}.md`.

11. **4.11 XLSX Import/Export** ✅ SHIPPED 2026-05-18 (W5-D-14a → W5-D-15.2 + W5-D-PM-1..5)
    Make `ql-io-xlsx` real: workbook load, formulas, cached values, names, sheets, tables, formats, date systems, and export.
    Acceptance: XLSX-4-01 ✅ import common workbooks (177/177 IronCalc fixtures); XLSX-4-02 ✅ formulas recalc through graph; XLSX-4-03 ✅ names/tables/formats/per-cell-application all survive round-trip; XLSX-4-04 ✅ corruption and unsupported features surface via `dropped_features` + Strict policy.
    Shipped: 11 commits W5-D-14a → W5-D-15.2 + 5 megaudit closure batches (W5-D-PM-1..5) closing 17 of 20 unique HIGHs from a 5-way parallel megaudit. Phase 4.11 megaudit transcripts at `docs/audits/2026-05-18-phase-4-11-megaudit-{design,codex,opus-a,opus-b,opus-c,self,consolidated}.md`. 3 deferred items tracked in `docs/PHASE-4-V2-BACKLOG.md`.

12. **4.12 Phase 4 Megaudit And Compatibility Freeze** ✅ SHIPPED 2026-05-18 (W5-D-PM12, PM12-1..PM12-3)
    Audit parser, functions, arrays, tables, xlsx, and compatibility matrix.
    Acceptance: A4-01 ✅ all gates green (4135 workspace tests); A4-02 ✅ compatibility matrix (311 rows, 83% coverage); A4-03 ✅ Excel corpus smoke green (177/177 fixtures); A4-04 ✅ test count 4135 / 946 Phase 3 exit = 4.37× (target ≥ 2× cleared).
    Shipped: 5-way parallel megaudit (Codex / Opus-A / Opus-B / Opus-C / self) caught 19 unique HIGHs invisible at per-sub-phase level; 5 closed (correctness + panic + matrix integrity + NUL-in-strings + parser-and-semantics index); 14 deferred to Phase 5 prep with explicit dispositions in `docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md` + tracked in `docs/PHASE-4-V2-BACKLOG.md`. Phase 4 exit packet at `docs/phase4/exit-packet.md` (ACTIVE).

**Audit Checkpoints**

- Parser audit after 4.1-4.2.
- Megaudit after 4.11.

**IDE Proof Points**

- IDE must open an imported `.xlsx`, show formulas, edit formulas, save `.qbook`, and export `.xlsx`.
- Formula bar must handle cross-sheet refs, arrays/spills, and localized/R1C1 modes if enabled.

**Exit Criteria** — ALL MET (Phase 4 SHIPS 2026-05-18)

- ✅ Excel compatibility matrix exists and drives work (`docs/compat/excel-matrix.md`, 311 rows, 83% coverage).
- ✅ Function target reached (260 registered fns, V1-260 hit `5d117724f27`).
- ✅ xlsx import/export works for v1 corpus (177/177 IronCalc fixtures).
- ✅ Arrays/spills/tables/cross-sheet references are graph-integrated.

**Phase 4 SHIPPED at HEAD `3b8939d9522` on `feat/quantbook-engine`.** Exit packet: `docs/phase4/exit-packet.md` (ACTIVE). Phase 4.11 + 4.12 megaudits closed 17 + 5 = 22 HIGHs invisible at per-batch level; 14 deferred to Phase 5 prep with explicit rationale.

**Documentation Deliverables**

- `docs/phase4/entry-plan.md` ⚠️ MISSING (Phase 4 was opportunistic; documented as v1 deferred per Phase 4.12 megaudit self-audit H-1).
- `docs/phase4/exit-packet.md` ✅ ACTIVE (2026-05-18).
- `docs/compat/excel-matrix.md` ✅ 311 rows, 83% coverage.
- `docs/architecture/parser-and-semantics.md` ✅ INDEX shipped 2026-05-18 (W5-D-PM12) pointing at 9 underlying architecture docs.
- Updated legal/provenance notes ⚠️ EXISTS per-source in `.references/` but no top-level summary; deferred.
- `docs/PHASE-4-V2-BACKLOG.md` ✅ (NEW 2026-05-18) — aggregated 14 deferred HIGHs from Phase 4.11+4.12 megaudits.

## Phase 5 - Multi-User CRDT Collaboration

**Status (2026-05-23): Phase 5 V1 + D-1 + 5.3 + 5.5 V2 V2 + 5.5 V2 V3 V1 (steps 1-6) + 5.5 V2 V4 V1 (12/13 Tier items; K4 chunking deferred to V2 V4 V2) + 5.7 V1 + 5.7 V2 (V2.1 -> V2.7 + V2.8 megaudit + V2.9) + 5.7 V3.1 (a-e multi-window IDE demo + 2-lane audit + 6 actionable closures) + 5.7 V3.2 (a + a.1 + b + c + d + e cell-grid UI vertical slice + 2-lane audit + 5 actionable closures + exit packet) + 5.7 V3.3.0 (0.1-0.7 + 0.X 2-lane megaudit + 10 actionable closures + plan archive) ALL SHIPPED + AUDITED. ✅ **5.7 V3.4 (undo/redo + .qbook persistence + presence integration, ALL 9 SUB-STEPS SHIPPED + AUDITED 2026-05-23 to 2026-05-24)** -- 0.1 decision lock (5 D-decisions; D5 deviation documented at 0.4b); 0.2 hybrid CellState cache (PutValue+PutFormula+ClearFormula); 0.3 undo/redo napi + Cmd-Z webview wiring; 0.4a engine .qbook napi (toQbook/fromQbook/addSheet + 3 new napi-crate deps + persistence_error_to_napi); 0.4b IDE Save As/Open commands + generateUuidPeerId helper; 0.5a presence napi (5 wrappers + PresenceStateJson struct); 0.5b IDE cell-grid presence integration; 0.7 docs `ide-consumer-contract.md § 4.1.z4` (~460 lines); **0.X cumulative megaudit (2026-05-24)** -- Codex Lane A + Opus Lane B parallel; both PASS-WITH-FINDINGS; 3 HIGH + 3 MEDIUM + 3 LOW closed in-cycle (1 cross-lane convergent HIGH: sample-data addSheet seeding); 3 MEDIUM doc-deferred (R-V3.4-3 RECLASSIFIED to KNOWN-GAP via Opus M2 -- host-driven webview.html rebuild during mid-edit destroys input; V3.4.0.5c follow-up MUST add host-level mid-edit-render guard); 5 LOW V3.4.1+ backlog.  Engine HEAD `aec5a9cc1df` (V3.4.0.X engine closures); IDE HEAD `b6a3f48572a` (V3.4.0.X IDE closures); plan archived at `2706d555149`.  🚧 **5.7 V3.5 (IDE-side `rebuild_workbook` consumption + full Op enum cache + partial-invalidate undo + sheet ops + R-V3.4-3 KNOWN-GAP closure, V3.5.0.1 decision lock IN PROGRESS 2026-05-24)** at engine `(THIS commit)`.  Five D-decisions locked per V3.4.0.X Opus § F V3.5 ENTRY READINESS packet: **D1** extend `CellState` with `format: Option<FormatId>` (session-wide format/name/table state stays on `Workbook` + surfaces via D3 WorkbookSnapshot); **D2** partial-invalidate undo for cell-keyed ops (full-rebuild fallback for session-wide ops); **D3** `WorkbookSnapshotJson` napi struct = flattened JSON-serializable view (sheets/cells/names/formats); **D4** `renameSheet`/`deleteSheet`/`moveSheet` napi + IDE multi-sheet UX commands; **D5** host-level `presenceRepaintInFlight` boolean mid-edit-render guard closing R-V3.4-3 KNOWN-GAP via V3.4.0.5c carry.  10 planned V3.5.0 sub-steps; multi-week arc; expect 6-9 sessions. Canonical records: `docs/phase5/v1-exit-packet.md` (V1) + `docs/phase5/d-1-exit-packet.md` + `docs/phase5/5-3-exit-packet.md` + `docs/phase5/v2-v3-exit-packet.md` + `docs/phase5/v2-v4-v1-exit-packet.md` + `docs/phase5/5-7-v1-exit-packet.md` + **`docs/phase5/5-7-v2-exit-packet.md` (5.7 V2 closure)** + **`docs/phase5/5-7-v3-2-exit-packet.md` (5.7 V3.2 closure -- cell-grid UI vertical slice; FIRST product-user-visible surface)**. Remaining: 5.7 V3.5.0.2-V3.5.0.X (10 sub-step implementation arc; V3.5.0.7 closes R-V3.4-3 KNOWN-GAP via host-level mid-edit-render guard) + V3.4.1+ (advanced undo + persistence polish + presence polish; per-peer color hashing; per-workbook PeerId stash if attribution feature surfaces) + V3.6+ (live formula re-evaluation in IDE + WorkbookSnapshot incremental deltas + CacheState promotion if profiling justifies), 5.8 Phase 5 megaudit (~4-6d, UNBLOCKED), V2 V4 V2 K4 chunking (~2-3d). **V3.3.1+** (incremental rendering polish) deferred indefinitely; V3.3.0 covers V3.4 prerequisites. **V2 audit ladder: 12 V2.1-V2.7 cycles + V2.8 megaudit (3 lanes) + V2.8 closures + V2.9 = 14 cycles. V3.1 audit ladder: V3.1.a-e = 5 sub-steps + V3.1.e 2-lane parallel audit + 6 actionable closures. V3.2 audit ladder: 4 ship cycles + V3.2.d 2-lane parallel audit + 5 in-cycle code closures = 5 cycles. V3.3.0 audit ladder: 7 sub-steps (0.1-0.7) shipped + 0.X 2-lane megaudit + 10 actionable closures + plan archive; +41 cumulative V3.3.0-specific mocha tests (140 -> 181) + 2 new ql-collab tests (74 -> 76). Cumulative findings closed across Phase 5.7: 13+ HIGH + 45+ MEDIUM. Rule 4 arc terminus = 6 (V2.7 + V2.8 megaudit + V3.1.e + V3.2.a + V3.2.a.1 + V3.2.b + V3.2.c + V3.2.d + V3.3.0.3 last_snapshot per-field walk (independently re-verified at V3.3.0.X by Opus) + V3.3.0.4 + V3.3.0.5 + V3.3.0.X: 0 new triggers).** Audit transcripts: **29 in `docs/audits/2026-05-22-phase-5-7-*` + `docs/audits/2026-05-23-phase-5-7-*` + `docs/audits/2026-05-24-phase-5-7-*`** (5 V1 + 13 V2.1-V2.7 + 3 V2.8 megaudit + 2 V3.1.e + 2 V3.2.d + 2 V3.3.0.X + 2 V3.4.0.X).

**Purpose:** Turn collaboration from a single-writer op log into real multi-user CRDT state for sheets, cells, names, tables, presence, undo/redo, and offline sync.

**Entry State Required**

- Phase 3 graph runtime exists.
- Phase 4 semantics are broad enough that collaboration does not need to redesign value/formula/table structures.

**Dependencies**

- Requires stable operation vocabulary from `ql-oplog`.
- Requires storage semantics for computed versus user state.
- Requires IDE proof surface for multi-user presence.

**Sub-items**

1. **5.1 Collaboration Data Model Decision** ✅ SHIPPED 2026-05-19 (`918d7efdd91` + `df52cb44ad2`).
   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 ✅ SHIPPED 2026-05-20 (see 5.2 + `docs/phase5/d-1-exit-packet.md`).

2. **5.2 `ql-collab` Core Documents** 🟡 IN PROGRESS.
   - ✅ D-2 (`1ca19e2fa37`) AddSheet auto-rename.
   - ✅ D-3 (`e71312d4bcd`) UnknownSheet → #NAME?.
   - ✅ D-4 (`2f217a2067a`) OpLog::merge_bytes + 2-peer spill probe.
   - ✅ 5.2.a scaffold (`66a571b30af`).
   - ✅ 5.2.b PeerId → LoroDoc wiring (`ef056f50bee`).
   - ✅ **D-1 (FormatId tagged tuple, multi-day) — SHIPPED 2026-05-20.** All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit complete. **16/16 audit cycles caught real bugs.** Workspace tests: 4222 → 4291 (+69). See `docs/phase5/d-1-exit-packet.md` for the closure record + `docs/phase5/d-1-starting-checklist.md` for execution-trace history.

3. **5.3 Conflict Resolution Semantics** ✅ SHIPPED 2026-05-20. Causality-aware rename-repair pass for sheets + tables + columns. 4 days actual (vs 4-7 day estimate). All 6 steps + 14 audit cycles complete. **14/14 audit cycles caught real bugs.** Workspace tests: 4291 → 4361 (+70). New public API: `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` convenience wrapper. See `docs/phase5/5-3-exit-packet.md` for the closure record + 20 audit transcripts at `docs/audits/2026-05-20-phase-5-3-*.md`. 13 V1 limitations tracked at `docs/PHASE-4-V2-BACKLOG.md` Tier H. **Production-visible D-3 closure happens at step 5.7 IDE binding** (rebuild_workbook is shipped as the API entry; IDE has to wire it).

4. **5.4 Undo/Redo And Operation Grouping** ✅ V1 + V2 V1 + V2 V1.1 SHIPPED 2026-05-19.
   - V1 (`89c02b9d83e`): 7 undo/redo methods on CollabSession wrapping `loro::UndoManager`; presence-origin commits auto-excluded.
   - V2 V1 (`6138a7203f6` + `e199a5fda5a`): `start_undo_group` / `end_undo_group` + `set_undo_merge_interval`.
   - V2 V1.1 (`7cbdc689ea9`): RAII `start_undo_group_scoped` returning `UndoGroupGuard` (panic/Err-safe). Codex audit PASS.
   - V2 V2 pending: push/pop listeners (lower priority, speculative).

5. **5.5 Transport Layer And Offline Sync** ✅ **V2 V3 V1 SHIPPED 2026-05-21**. All 6 steps (delta flush + poll_remote auto-flush + offline-write story + WebSocket transport + 3-way megaudit + exit packet) closed. Canonical record: `docs/phase5/v2-v3-exit-packet.md`. V2 V4 (TLS, auto-reconnect, bounded backpressure, server crate, ack channel) is `PHASE-4-V2-BACKLOG.md` Tiers I+J+K.
   - V1 (`924750819bc`): `Transport` trait + `NoopTransport` + `LoopbackTransport::pair()`.
   - V2 V1 (`ffd8f6e5f05`): `CollabSession::{attach,detach,has}_transport` + `flush_to_transport` + `poll_remote` (+ `_with_limit`). Explicit-drive.
   - V2 V2 (`51748b02944` ship + `b7aa4cb7bb9` audit-closure): `AutoFlushPolicy::{Disabled, OnAppend}` enum. Default `Disabled` (V2 V1 behavior); `OnAppend` triggers flush after every mutator.
   - V2 V3 step 1 (`603bdc9aa6c` ship + `e5ff11d549a` audit-closure): per-transport version-vector tracking + `CollabSession::flush_delta_to_transport` using `LoroDoc::ExportMode::Updates`. Auto-flush reroutes through the delta path. Idempotency short-circuit closes V2 V2 audit echo-loop class. New `OpLog` API: `oplog_vv()` + `export_delta_bytes(&VersionVector)`.
   - V2 V3 step 2 (`e4e1ce282b1` ship + `fc3de6f99c7` audit-closure): wires `poll_remote*` into auto-flush. One flush per drain batch. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion. 3-peer hub fanout works automatically under `OnAppend`.
   - V2 V3 step 3 (`c73249d338c` ship + `10f40eb228b` audit-closure): offline-write story. Investigation showed no explicit queue needed — Loro's CRDT op log IS the implicit offline queue. Append while no transport returns Ok + commits locally; reattach + flush sends all accumulated ops (delta from empty VV). Adds `CollabSession::has_pending_flush()` ergonomic helper. 7 ship + 5 closure tests pin the contract.
   - **V2 V3 step 4 ✅ SHIPPED 2026-05-21**: WebSocket transport impl. New crate `ql-collab-ws::WebSocketTransport`. Bridges async tokio-tungstenite (`=0.29.0`) to sync `Transport` trait via `tokio::sync::mpsc` + 2 background tasks. MVP: client-only, plain `ws://`, NO TLS, NO auto-reconnect (caller drives via detach+attach), unbounded outbound queue (bounded in practice — closed-flag fast-paths the common disconnect case; dead-peer scenario is the genuine growth window). 13 integration tests against in-process echo server including 3 that verify V2 V2 + V2 V3 step 1-3 contracts hold over a real WebSocket. V1 limitations deferred to V2 V4 (TLS, bounded backpressure, reconnect wrapper, server-side crate, inbound text/ping/pong frame dropping).
   - V2 V3 step 5 megaudit (`bce64a5c1ce` 3-way Codex+Opus-A+Opus-B closure): 2H+11M+9L total. Convergent finding queued-vs-acked semantics documented; ack channel deferred to V2 V4 Tier K1. Opus-A H1 (`last_error()` unreachable through Box<dyn>) closed: lifted `Transport::last_error()` to trait + `CollabSession::transport_last_error()` proxy. Plus `TaskExitGuard` RAII panic detection + Close-frame reason capture + poisoned-mutex no-fallback fix. 9 Tier K V2 V4 backlog entries.
   - **V2 V3 step 6 ✅ SHIPPED 2026-05-21**: V1 exit packet at `docs/phase5/v2-v3-exit-packet.md` + consumer doc rewrite at `docs/architecture/ide-consumer-contract.md` § 4.1.1-3 (3 worked-example subsections — Synced/Unsynced indicator, reconnect handshake with retry-action table, offline-write recovery with explicit-flush idiom). Phase 5.7 IDE vertical slice UNBLOCKED.

6. **5.6 Presence And Awareness** ✅ V1 + V2 SHIPPED 2026-05-19.
   - V1 (`c677e244704`): `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods.
   - V2 (`d4b3cdb2dc2`): `sweep_presence` caller-opt-in clean-slate.

7. **5.7 Collaboration IDE Vertical Slice** ✅ **V1 SHIPPED + 3-WAY MEGAUDITED + DOCS-FINALIZED 2026-05-22**. ✅ **V2 (V2.1 through V2.7 + V2.8 megaudit + V2.9) ALL SHIPPED + AUDITED + V2 PHASE TERMINATED 2026-05-22** (V2 exit packet at `docs/phase5/5-7-v2-exit-packet.md`). ✅ **V3.1 (multi-window IDE demo, a-e) SHIPPED + 2-LANE AUDITED 2026-05-22** (5 V3.1 sub-steps + V3.1.e parallel Codex+Opus + 6 actionable closures). ✅ **V3.2 (cell-grid UI vertical slice) SHIPPED + 2-LANE AUDITED + EXIT-PACKETED 2026-05-22** (V3.2.a scaffold + V3.2.a.1 ergonomic refresh + V3.2.b nonced cell-edit + V3.2.c live multi-window propagation + V3.2.d parallel Codex+Opus audit with 5 in-cycle closures + V3.2.e exit packet at `docs/phase5/5-7-v3-2-exit-packet.md`). ✅ **V3.3.0 (multi-sheet + virtualization, 0.1-0.7 + 0.X) SHIPPED + AUDITED 2026-05-22 to 2026-05-23** (V3.3.0.1 decision lock + V3.3.0.2 `listSheets()` napi + V3.3.0.3 `exportSnapshot` incremental cache via per-session `last_snapshot: HashMap<(u16, u32, u32), CellWireValue>` with Rule 4 per-field walk + V3.3.0.4 custom-inline virtualization scaffold + V3.3.0.5 multi-sheet UX command + V3.3.0.6 audit-gap closures + V3.3.0.7 ide-consumer-contract.md § 4.1.z3 docs + V3.3.0.X parallel Codex+Opus megaudit with 10 in-cycle closures). First IDE binding to the quantbook engine; FIRST PRODUCT-USER-VISIBLE surface of the entire Phase 5.7 arc. Cross-repo: new `crates/ql-bindings-node/` (napi-rs 3.x cdylib) with `listSheets()` + cache-backed `exportSnapshot` + new `extensions/quantlab/src/quantbook/` (loader + types + session wrapper + multiWindowDemo + cellGrid: cellGridHtml.ts + cellGridLogic.ts + cellGridPanel.ts) + 6 commands (`quantlab.quantbookDemo` V1 single-window + `quantlab.quantbookDemoMultiWindow` V3.1 + `quantlab.quantbookCellGrid` V3.2.a local-only + `quantlab.quantbookCellGridRefresh` V3.2.a.1 + `quantlab.quantbookCellGridCollab` V3.2.c live multi-window + `quantlab.quantbookCellGridSwitchSheet` V3.3.0.5 multi-sheet picker) + **176 mocha tests** in the quantlab VS Code fork.

   **V1**: minimum coherent `CollabSession` surface (constructor / `fromSnapshot` / `appendPutValue` / `exportBytes` / `mergeBytes` / `opCount` / `pendingOpCount` / `hasPendingFlush` / `peerId`). Engine commits `677ee03ee8b` → `6003db4ce2c` → `c47bc0816b5` → `c7406aa82cd`. IDE `1a7fc8bbe3f` → `a517d7c5f71` → `97e0513d134`. 3-way megaudit (Codex + Opus-A docs + Opus-B V2-readiness): 5 HIGH + 20 MEDIUM closed.

   **V2.1 (cycle 1)** — LoopbackPair foundations + 5 attach/flush/poll methods. Engine `c4e7b471142` → `39ed260bec9`. IDE `1f142366839` → `9da8d5df060`. Added `attach_transport_boxed` engine sibling (closes V1 megaudit Opus-B HIGH-2 generic-binding hazard). 2 HIGH + 1 MEDIUM closed.

   **V2.2 (cycle 2)** — full sync Transport surface (`flushDeltaToTransport`, `pollRemoteWithLimit`, `transportLastError`, `setAutoFlushPolicy`, `autoFlushPolicy`). Engine `d9b4168022d` → `d33876f7745`. IDE `b245c5b9fa8` → `3871c8ce055`. 2 HIGH (Opus 'unknown' sentinel no-fallback violation; contagious `as`-cast test pattern) + 3 MEDIUM closed.

   **V2.3 (cycle 3)** — async surface (`Transport.websocketConnect`, `flushPendingToTransport`). Engine `1e2354cb7b1` → `ea07bc6af4e`. IDE `6616e28a2a3` → `233957ab140`. **Audit FAIL** on first ship — Codex+Opus convergent on 2 HIGHs (Rust UB via napi `&mut self` async aliasing; tokio runtime starvation). Closure REMOVED `flushPendingToTransport`; V2.3 retained `websocketConnect` only (static async, safe). Real-network round-trip via Node `ws` localhost relay validated end-to-end.

   **V2.4 (cycle 4)** — sound `flushPendingToTransport` reintroduction via Arc<Mutex> refactor. Engine `c51df9f41f4` → `7123c6a57bb`. IDE `3ab02bbe732` → `8f0a44e19e9`. CollabSession wrapper refactored from `inner: CoreCollabSession` (&mut self methods) to `inner: Arc<parking_lot::Mutex<CoreCollabSession>>` (&self methods + internal lock + spawn_blocking for async). V2.3's 2 HIGHs STRUCTURALLY CLOSED (both auditors verified via source-walks of napi-derive-backend + lock_api + tokio). V2.4 audit found 2 NEW HIGHs: (1) V8-block UX hazard (sync method during pending flushPending blocks event loop — NOT a soundness hazard; deferred engine refactor V2.5+), (2) module docstring drift (Send+!Sync → Send+Sync). Both closed in V2.4 cycle.

   **V2.5 + V2.6 (cycle 5 combined)** — V8-block closure via Option A engine refactor. Engine `1b233af6150` → `81c66d02f9f`. IDE `c5997998741` → `8798349be6d`. Added `Transport::ack_handle(&self) -> Option<Box<dyn FlushAck + Send>>` default-None trait method + `WebSocketProgressAckHandle` (Codex M1 target snapshot AT call site, not at wait-start) + `CollabSession::flush_pending_handle(&self)` proxy. napi binding refactor: extract handle under session lock → drop lock → spawn_blocking wait without lock held. V2.6 added `BlockingTransport` test fixture behind `test-fixtures` Cargo feature + `BlockingTransportFixture` napi class to force deterministic contention for V2.5 contract testing. **V8-block VERIFIED CLOSED** by both audit lanes via source-walks. V2.5 contract test empirically passes: opCount() during 2000ms-blocked flushPending returns ~50ms. V2.5 audit verdicts: Codex 0H + 1M + 3L (M1 = production-cdylib DoS footgun, closed at binding via `block_ms > 0`); Opus 0H + 1M + 4L (Rule 4 #6 trigger: false `FlushAck: Send + !Sync` while impls Send + Sync; closed via positive Sync asserts).

   **V2.7 (cycle 7)** — structured `Error.code` discrimination. Engine `2a3e2ebcbfe` → `8f5b2e02ab7`. IDE `2a5619f9162` → `f9f98194958`. Closed the V2.1 Opus MEDIUM-3 carryforward (lossy `Display` projection of engine error variants; carried as V2.2 Opus MEDIUM-4 and re-flagged in V2.3 audit prep): every engine error enum got `kind() -> &'static str` accessors (TransportError, WebSocketError, CollabSessionError with Transport(inner) passthrough); napi binding got 3 helpers (`{collab_session,transport,websocket}_error_to_napi`) that prepend `[<kind>]` to Display strings; IDE got `parseQuantbookError(err) -> QuantbookErrorInfo` + `QuantbookErrorCode` union of 12 codes. V2.3 substring tests still pass (Display preserved after prefix). V2.7 audit: Codex 0H + 1L (all Q1-Q4 VERIFIED); Opus 0H + 3M + 4L (all required-walk VERIFIED). **0 Rule 4 triggers in V2.7**. Opus M2 (the big one) closed in-cycle: 14 napi-layer validation errors that silently bucketed under 'unknown' got the new `bad_argument` code prefix via `bad_argument_error(msg)` helper.

   **V2.8 (cycle 8 -- phase termination)** — 3-way cumulative megaudit + code closures. Engine `6917e36d846`. IDE `07bb0043dc4`. Three lanes ran in parallel against engine HEAD `4ea690ce246` + IDE HEAD `f9f98194958` for the cumulative V2.1-V2.7 surface. **Lane A (Codex protocol/correctness)**: PASS-WITH-FINDINGS, 0H + 2M + 3L. **Lane B (Opus-A docs/exit-readiness)**: PASS-WITH-FINDINGS, 5H + 8M + 10L (all DOC fixes, closed in this docs-finalize-v4). **Lane C (Opus-B adversarial + V3-entry readiness)**: PASS-WITH-FINDINGS, 1H + 4M + 4L. Lane C's HIGH escalated the V2.5 LOW-2 "production-cdylib BlockingTransportFixture leak" to required-pre-V3 (DoS surface: u32::MAX ms blocking-pool park via in-process JS). **Code closures shipped at V2.8**: (1) cfg-gate `BlockingTransportFixture` behind binding-side `test-fixtures` Cargo feature -- production cdylib strips the symbol entirely (verified via `strings`); (2) `scrub_url_credentials_in` helper scrubs `scheme://userinfo@` patterns from `WebSocketError::InvalidUrl` Display; (3) positive Sync compile asserts for `LoopbackPair` + `BlockingTransportFixture` (closes Rule 4 silence vs CollabSession's symmetric asserts); (4) `parseQuantbookError` walks `Error.cause` chain (depth-8, self-cycle guard) for napi `spawn_blocking` task-panic wrapper paths. 0 new Rule 4 triggers in Lane C per-field walks -- arc terminus 6.

   **Rule 4 arc terminus: 6** across V1 (×3) + V2.3 + V2.4 + V2.5. V2.7 + V2.8 megaudit + V3.1.e + V3.2.a + V3.2.a.1 per-field walks all yielded 0 new triggers.

   **V2.9 hardening (post-phase-termination)**: Lane C MEDIUM-3 closure via `Record<Exclude<QuantbookErrorCode, 'unknown'>, true>` compile-time enforcement of the IDE-side known-error-code set. IDE commit `58f607fe1d0`. Closes the one remaining required-pre-V3 item identified by V2.8 Lane C beyond the HIGH-1 cfg-gate that landed in V2.8.

   **V3.1 (multi-window IDE demo, 5 sub-steps a-e)** ✅ SHIPPED 2026-05-22. V3.1.a engine relay binary at `crates/ql-collab-ws/examples/relay-server.rs` (stateless broadcast with sender-side self-filter; V3.1.e Codex L2 added `tokio::signal` graceful shutdown via `JoinSet::abort_all`). V3.1.b IDE multi-window command `quantlab.quantbookDemoMultiWindow` (symmetric try-connect-first, peerId = BigInt(process.pid), reconnect-with-backoff 500/1000/2000ms × 3). V3.1.c reconnect UX (dispose-from-handler + Restart Demo action; ide-consumer-contract § 4.1.y reconnect contract). V3.1.d tests (2 V3.1.a relay integration + V3.1.b round-trip + V3.1.e Codex-L5 reconnect-mid-flight). V3.1.e parallel Codex+Opus audit: Codex 0H+1M+5L, Opus 0H+2M+9L; 6 actionable closures shipped (spawn race retry, Windows-cold-spawn timeout, signal-aware liveness, ide-consumer-contract doc, reconnect-mid-flight test, relay graceful shutdown). 2 audit transcripts at `docs/audits/2026-05-22-phase-5-7-v3-1-{codex,opus}.md`.

   **V3.2 (cell-grid UI vertical slice, 2026-05-22)** -- SHIPPED + AUDITED + EXIT-PACKETED.  See `docs/phase5/5-7-v3-2-exit-packet.md` for the full closure record covering V3.2.a (scaffold + `exportSnapshot` napi at commit `355a3226f0a`) + V3.2.a.1 (refresh + single-tab-per-sheet at IDE `130d28000ca`) + V3.2.b (nonced cell-edit flow at IDE `86b02d22a0b`) + V3.2.c (live multi-window propagation at IDE `a165141eb68`) + V3.2.d (2-lane audit at engine `61a515b4610` + IDE `ff73f2c9f1b` with 5 in-cycle closures) + V3.2.e (exit packet at engine `e514b9bf927`).  V3.2 ships the FIRST product-user-visible surface of the entire Phase 5.7 arc.

   **V3.3.0 (multi-sheet + virtualization, 2026-05-22 to 2026-05-23)** -- IN PROGRESS (0.1-0.6 shipped; 0.7 docs + 0.X audit pending).

   - **V3.3.0.1 (cycle 1)** -- decision lock (engine `5fd7ff73648`).  Six locked decisions per the V3.2.d Opus Lane B V3.3 entry-readiness packet: D1 custom-inline virtualization (no bundler), D2 panel-per-sheet UX, D3 `listSheets() -> Vec<u16>` napi shape (display-name deferred to V3.4+), D4 defer persistence to V3.4, D5 PESSIMISTIC rendering carries from V3.2.b.1 B4, D6 keep 1s pollRemote (push API deferred).

   - **V3.3.0.2 (cycle 2)** -- engine `CollabSession.listSheets()` napi method (engine `739611ac3b3`) + IDE typed wrapper `listSheets(session): number[]` + 5 mocha tests (IDE `33cc3f506a5`).  Walks op log; dedups via `BTreeSet<u16>`; returns sorted ascending.  Mocha 140 -> 145.

   - **V3.3.0.3 (cycle 3)** -- engine `exportSnapshot` incremental cache (engine `2bfba9b55ec`) closes V3.2.d Opus M4.  New field `last_snapshot: HashMap<(u16, u32, u32), CellWireValue>` on `CollabSession` with **Rule 4 per-field walk documented** (HashMap + tuple-of-primitives + CellWireValue all Send + Sync; inherits V2.4 Arc<Mutex<>> sync pinning; 0 new triggers).  5 op-mutation paths maintain the cache: `new` empty, `from_snapshot` rebuild, `append_op` O(1) incremental insert, `merge_bytes` full rebuild (causal-reorder safe), `discard_pending_ops` rebuild (log replaced), `poll_remote_with_limit` rebuild after drain.  napi `export_snapshot` refactored to read from cache via new `snapshot_cells()` accessor (O(cells-on-sheet) instead of O(N)).  **Regression caught + closed in-cycle**: `poll_remote_with_limit` bypassed `CollabSession::merge_bytes`; pre-fix V3.2.c.5 LWW loopback round-trip test FAILED; fixed by adding cache invalidation in the existing post-drain block.  4 new cache-invariant mocha tests (LWW / mergeBytes causal-reorder / pollRemote drain regression / fromSnapshot round-trip).  Mocha 145 -> 149.

   - **V3.3.0.4 (cycle 4)** -- IDE custom-inline virtualization scaffold (IDE `570c890f654`).  Pure helpers `computeVisibleRange(scrollTop, rowHeight, viewportHeight, totalRows, overscan=5)` + `buildVirtualRows<T>(entries, startIdx, endIdx)` in `cellGridLogic.ts` (vscode-free; mocha-driveable).  HTML viewport wrapping (`<div class="cell-grid-viewport">` max-height 80vh, overflow-y auto, sticky `<thead>`); tbody carries `data-virt-row-height="25"` + `data-virt-total-rows`; top + bottom spacer rows preserve total scroll geometry.  Full snapshot inlined as `<script id="cell-grid-data" type="application/json">` (CSP-safe non-executable; html-escapes embedded `</script>`).  Webview script adds scroll listener that recomputes visible range + repaints tbody innerHTML; **mid-edit safety via `activeInput !== null` guard** (skip repaint if user is mid-typing).  Virtualization gate: nonced mode + >40 entries.  18 new mocha tests.  Mocha 149 -> 167.

   - **V3.3.0.5 (cycle 5)** -- IDE multi-sheet UX command (IDE `dbc2bb517b0`).  NEW `quantlab.quantbookCellGridSwitchSheet` command: `CellGridPanel.activeLocalPanels()` → `listSheets(session)` → `vscode.window.showQuickPick` (current sheet marked `(current)`) → `CellGridPanel.show(context, session, selectedSheet)` opens a NEW panel for the chosen sheet (panel-per-sheet per D2).  Panel title now reads `Cell Grid (Sheet N of M)` / `Cell Grid -- Collab (Sheet N of M)` via `session.listSheets().length` at show() time; single-sheet sessions show just `Sheet N`.  V3.2.a `quantbookCellGrid` command now seeds sample data on sheets 0/1/2 (was just 0).  New pure helper `buildSheetQuickPickItems(sheets, currentSheet): SheetQuickPickItem[]`.  5 new mocha tests.  Mocha 167 -> 172.

   - **V3.3.0.6 (cycle 6)** -- audit-gap closures (IDE `96b9afa37c4`).  After a post-V3.3.0.5 deep audit surfaced 8 gaps (2 HIGH docs drift; 1 MEDIUM missing scroll-simulation test; 5 LOW polish/docs), this cycle ships: drift-hazard JSDoc on `buildClientScript` (formatCellValueClient / renderRowsClient mirror server-side `formatCellValue` / `renderRows`); multi-panel selection-semantic JSDoc on switch-sheet command (`panels[0]` = oldest); `listSheets`-per-show cost-bounded acknowledgement comment.  4 new mocha tests covering scroll-simulation via pure-helper composition (monotonic advancement; spacer geometry across snapshot sizes; tight single-row scrollTop increments; title-computation point-in-time contract).  jsdom not in tree so a true DOM-based integration test deferred to V3.x.  Mocha 172 -> 176.

   - **V3.3.0.7 (cycle 7, pending)** -- ide-consumer-contract.md § 4.1.z3 V3.3 multi-sheet + virtualization contract docs.

   - **V3.3.0.X (audit + 10 in-cycle closures)** ✅ SHIPPED 2026-05-23 (engine `73e31df1737` + IDE `6dcc7ef9a20`).  Parallel Codex Lane A + Opus Lane B megaudit over V3.3.0.1-7 cumulatively.  **Codex: PASS-WITH-FINDINGS** (1 HIGH + 2 MEDIUM + 3 LOW; transcript at `docs/audits/2026-05-23-phase-5-7-v3-3-0-x-codex.md`).  **Opus: PASS-WITH-FINDINGS** (2 HIGH + 5 MEDIUM + 4 LOW; transcript at `docs/audits/2026-05-23-phase-5-7-v3-3-0-x-opus.md`).  Cross-lane convergent: HIGH-1 undo/redo cache bypass (both); MEDIUM-1 rebuild atomicity (both); docs drift (both); switch-sheet inline comment (both); row/col attr escape (both).  **10 of 11 findings closed in-cycle**: HIGH-1 (undo/redo call `rebuild_snapshot_cache`); HIGH-2 (remove silent listSheets catch from CellGridPanel.show -- CLAUDE.md No-Fallbacks closure); MEDIUM-1 (atomic-swap rebuild); MEDIUM-2 (docstring 5→7 paths sweep); MEDIUM-3 (listSheets reads from cache via new `list_sheets_from_cache` helper); MEDIUM-4 (switch-sheet "OLDEST" comment); MEDIUM-5 (new `force_clear_snapshot_cache` test seam closes R-V3.3-2); LOW-1 (defense-in-depth Number() coercion on row/col attrs).  1 LOW deferred to V3.x (Opus L2 static_assertions !Sync refactor).  **Rule 4 arc terminus held at 6** (Opus independently re-verified the V3.3.0.3 `last_snapshot` per-field walk's three claims against source; no new triggers).  +5 IDE mocha (176 -> 181) + 2 new ql-collab tests (74 -> 76).

   🚧 **V3.4 (undo + persistence + presence, 0.1-0.5 + 0.4a/b + 0.7 SHIPPED 2026-05-23)** -- 8 V3.4.0 sub-steps shipped; only 0.X audit remains.  Five locked D-decisions per V3.3.0.X Opus § V3.4 ENTRY READINESS: **D1 hybrid CellState cache** (unified `CellState{value, formula, ...}` for cell-keyed ops; non-cell ops stay on Workbook state); **D2 full-rebuild undo invalidation** (carries V3.3.0.X HIGH-1; partial-invalidate deferred to V3.5+); **D3 envelope-level persistence versioning** (V3.4.0.4a reuses existing v2 `workbook.toml.schema_version` from Phase 2A.8; no bump needed); **D4 boolean-flag race guard** (extends V3.3.0.4 `activeInput` pattern; R-V3.4-3 deferred at V3.4.0.5b implementation -- full HTML rebuild on every pollRemote merged tick handles regeneration); **D5 UUID-derived PeerId** -- **DEVIATED at V3.4.0.4b**: original lock specified persisted-per-workbook PeerId via envelope v3 / config file; implementation discovery showed two-windows-same-workspace collision; resolution is fresh-UUID-per-session via `crypto.randomUUID()` truncated to 64-bit BigInt, which is CRDT-correct + closes R-V3.3-5 fully (UUID 2^64 keyspace vs PID ~2^15 effective).  Cross-restart op-attribution continuity deferred to V3.4.1+ if user-facing feature surfaces.  Sub-steps shipped: 0.1 decision lock (engine `a87c31eed4f`); 0.2 hybrid CellState cache + 3 new ql-collab tests (engine `1ae59a1a1aa`); 0.3 undo/redo napi + Cmd-Z wiring + 13 mocha (engine `7d63ff53132` + IDE `673792af05f`); 0.4a engine .qbook napi (toQbook/fromQbook + `addSheet` REAL SEMANTIC GAP closure + 3 new napi-crate deps ql-io/ql-functions/ql-storage + persistence_error_to_napi + 5 mocha; engine `bef220d7d3c` + IDE `ec9b59db8a5`); 0.4b IDE Save As/Open + generateUuidPeerId + 4 mocha (engine `a1e2c673381` plan-only + IDE `fa7ec198cee`); 0.5a presence napi (5 wrappers + PresenceStateJson struct + 9 mocha; engine `5ce55f65739` + IDE `8ff2d81f1e4`); 0.5b IDE cell-grid presence integration (cell-grid-presence data block + .cell-peer-presence decoration + presenceUpdate envelope + R-V3.4-7 VOIDED + R-V3.4-3 DEFERRED + 16 mocha; engine `cd26a37b513` plan-only + IDE `1744cee11af`).  +47 cumulative V3.4-specific mocha tests (181 -> 228) + 3 new ql-collab tests (76 -> 79).  Rule 4 arc terminus held at 6 throughout (V3.4 surface adds one new Rust struct `PresenceStateJson` -- composition of u16/u32/bool primitives; trivially Send+Sync; 0 new triggers).  **0.6 mocha is EFFECTIVELY COMPLETE** via incremental per-sub-step coverage (47 V3.4-tests vs the plan's "~15 new" target).  **0.7 docs SHIPPED** at engine `fe10a245d07` (ide-consumer-contract.md § 4.1.z4 insertion; ~460 lines / file 837 -> 1280; covers full V3.4 napi surface + CellState cache + undo/redo + .qbook persistence + D5 DEVIATION + presence + 6 drift hazards + risk register R-V3.4-1..6 post-implementation reality + 12 out-of-scope items + steps 7-11 live smoke procedure extending V3.3.0.6).  Remaining: **0.X parallel Codex+Opus megaudit** (~4-6h cycle; sweeps V3.4.0.1-7 cumulatively).

   **V3 backlog (open)**: 🚧 **V3.5 IN PROGRESS** (V3.5.0.1 decision lock shipped THIS commit; V3.5.0.2-V3.5.0.X implementation arc -- WorkbookSnapshot napi + sheet ops napi + IDE consumption commands + CellState format extension + partial-invalidate undo + mid-edit-render guard for R-V3.4-3 KNOWN-GAP closure + mocha + docs § 4.1.z5 + parallel megaudit; ~6-9 sessions).  V3.4.1+ polish (deferrable; advanced undo + persistence polish: auto-save / last-saved-time indicator / multi-sheet picker in Open UX; presence polish: per-peer color hashing via peerId hash + tooltips; threshold-based sweepPresence variant when engine ships it; per-workbook PeerId stash IF user-facing "show my contributions" feature surfaces).  V3.6+ (live formula re-evaluation in IDE + WorkbookSnapshot incremental deltas + CacheState { cells, formats, names, tables } promotion if profiling justifies + chart / pivot napi surfaces + vscode-test command-flow tests).  **V3.3.1 incremental rendering polish DEFERRED INDEFINITELY** (V3.3.0 covers V3.4 prerequisites; polish revisits only if smoke surfaces issues).  Smaller backlog items deferred from V2/V3.1.e/V3.2.d/V3.3.0.6/V3.4.0.5: structured `transportLastErrorInfo()` accessor; `willFlushSend()` helper; `LoopbackTransport.close()` binding; HandshakeFailed test fixture; `CollabSessionError::Transport(_)` origin tracking; `@napi-rs/cli` publish pipeline; `#[napi(strict)]` sweep; AtomicUsize conn_id wrap on relay (V3.1.e Codex L3); per-cell incoming-tint animation (V3.2.c.1 C5); persistent status-bar item (V3.2.c.1 C4); push-API for inbound observation (V3.2.c.1 C2 / V3.3.0.1 D6 / V3.4 carry); jsdom-based virtualization integration test (V3.3.0.6 deferral).  **R-V3.3-5 PeerId reuse cross-restart CLOSED at V3.4.0.4b via fresh-UUID-per-session** (D5 deviated from original "persisted-peerId" lock; see V3.4 narrative for the implementation-discovery rationale).  **R-V3.4-7 sweep cadence VOIDED at V3.4.0.5b** (engine sweepPresence is no-threshold; periodic sweep would clobber live remote peers).  **R-V3.4-3 presenceRepaintInFlight DEFERRED at V3.4.0.5b** (full HTML rebuild on every pollRemote merged tick handles regeneration; existing activeInput guard covers tbody clobber).  **V2.7 Opus L2 RETIRED at V2.8.** **V2.8 Lane C MEDIUM-3 CLOSED at V2.9.** **V2.5 LOW-2 + V2.8 Lane A LOW-1 CLOSED at V2.8 HIGH-1 cfg-gate.**  **V3.2.d Opus M4 CLOSED at V3.3.0.3 incremental cache.**

   Canonical records: `docs/phase5/5-7-v1-exit-packet.md` (V1 closure) + **`docs/phase5/5-7-v2-exit-packet.md` (V2 phase termination)** + **`docs/phase5/5-7-v3-2-exit-packet.md` (V3.2 phase termination)**.  V3.3 exit packet skipped (V3.3.0.X megaudit transcripts + archived plan provide canonical record).  V3.4 exit packet skipped (the V3.4.0.X megaudit transcripts + archived plan provide canonical record; mirrors V3.3.0.X policy).  **29 audit transcripts** in `docs/audits/2026-05-22-phase-5-7-*` + `docs/audits/2026-05-23-phase-5-7-*` + `docs/audits/2026-05-24-phase-5-7-*` (5 V1 + 13 V2.1-V2.7 + 3 V2.8 megaudit + 2 V3.1.e + 2 V3.2.d + 2 V3.3.0.X + 2 V3.4.0.X).

8. **5.8 Phase 5 Megaudit** — future. Depends on 5.1-5.7 V2+ complete (V1 binding is too thin; megaudit value comes once V2 Transport surface is in scope).

**Audit Checkpoints**

- Design audit after 5.1 before implementation.
- Megaudit after 5.7.

**IDE Proof Points**

- This phase requires a two-peer IDE collaboration slice.

**Exit Criteria**

- `ql-collab` is real.
- Cells, formulas, names, sheets, and tables merge deterministically.
- Offline sync and conflict diagnostics work.
- Single-writer op log is no longer confused with collaboration.

**Documentation Deliverables**

- `docs/phase5/entry-plan.md` ✅ (status: SUPERSEDED-BY-EXIT-PACKET).
- `docs/phase5/v1-exit-packet.md` ✅ (Phase 5 V1 canonical closeout 2026-05-19).
- `docs/phase5/d-1-starting-checklist.md` ✅ (D-1 fresh-session entry).
- `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
- 23 audit transcripts at `docs/audits/2026-05-19-*` covering 11 audit cycles.
- Protocol/versioning notes — pending D-1 + 5.5 V2 V2/V3 work.

## Phase 6 - Product Surfaces

**Purpose:** Expose the same engine through service mode, WASM, Node, C, Python, SQL, connectors, Python UDFs, and AI().

**Entry State Required**

- Phase 4 compatibility and Phase 5 collaboration are stable enough to expose.
- Core runtime API no longer churns daily.

**Dependencies**

- Python UDFs depend on function metadata, cancellation, and volatile/lazy semantics.
- AI() depends on lazy/error semantics and cancellation.
- Bindings depend on stable runtime/session APIs.

**Sub-items**

1. **6.1 Stable Engine Session API**  
   Define a common API used by service and bindings: open, edit, batch, recalc, query range, save, import/export, subscribe diagnostics, cancel.  
   References: `.references/formualizer/crates/formualizer-workbook/src/session.rs`; `.references/formualizer/crates/formualizer-sheetport/src/session.rs`; `.references/formualizer/bindings/wasm/src/index.ts`; `.references/formualizer/bindings/python/src/engine.rs`.  
   Acceptance: API6-01 one Rust trait/API backs all bindings; API6-02 cancellation included; API6-03 errors are structured.  
   Effort: 4-6 days.

2. **6.2 `ql-service` Engine-As-Service**  
   Implement local service transport. Choose HTTP/gRPC deliberately; document choice. Include auth hooks, cancellation, streaming diagnostics, and workbook lifecycle.  
   References: `.references/formualizer/crates/formualizer-sheetport/src/runtime.rs`; `tokio` workspace deps.  
   Acceptance: SVC-6-01 service opens and edits workbook; SVC-6-02 streams diagnostics; SVC-6-03 cancellation works; SVC-6-04 protocol versioned.  
   Effort: 1 week.

3. **6.3 WASM, Node, C, Python Bindings**  
   Make `ql-bindings-wasm`, `ql-bindings-node`, `ql-bindings-c`, and `quantbook-py` real over the stable session API.  
   References: `.references/formualizer/bindings/wasm/`; `.references/formualizer/bindings/python/`; `.references/formualizer/crates/formualizer-cffi/`.  
   Acceptance: BND-6-01 smoke tests for all bindings; BND-6-02 C ABI guardrails; BND-6-03 Python wheel builds; BND-6-04 Node binding consumed by IDE path or test harness.  
   Effort: 2-3 weeks.

4. **6.4 Python UDFs (`ql-udf`)**  
   Register and execute Python UDFs through PyO3 with sandbox boundaries, timeouts, cancellation, type conversion, and deterministic error mapping.  
   References: `.references/formualizer/bindings/python/examples/custom_function_registration.py`; `.references/formualizer/crates/formualizer-workbook/tests/custom_functions.rs`; `.references/formualizer/crates/formualizer-eval/src/function.rs`.  
   Acceptance: UDF-6-01 Python UDF callable from formula; UDF-6-02 timeout/cancel works; UDF-6-03 type conversion matrix tested; UDF-6-04 sandbox limitations documented.  
   Effort: 1-2 weeks.

5. **6.5 SQL Surface And Connectors**  
   Implement `ql-sql` and `ql-connectors`: SQL over sheets/tables, external refresh, credentials boundary, Arrow interop, and explicit dependency invalidation.  
   References: `.references/formualizer/crates/formualizer-workbook/src/backends/csv.rs`; `.references/formualizer/crates/formualizer-workbook/tests/csv_backend.rs`; workspace pins for DuckDB/DataFusion/Polars are not hot-path engine approvals.  
   Acceptance: SQL-6-01 query table/sheet; SQL-6-02 materialize result to sheet; SQL-6-03 refresh dirties dependents; CONN-6-01 CSV/local connector; CONN-6-02 errors visible.  
   Effort: 1-2 weeks.

6. **6.6 AI() Real Backend (`ql-ai`)**  
   Replace sentinel with real provider boundary, prompt/value marshalling, cancellation, caching policy, provenance, and no-secret-leak defaults.  
   References: Phase 1 AI sentinel tests; function metadata from Phase 4; service cancellation from 6.2.  
   Acceptance: AI-6-01 AI() executes through configured backend; AI-6-02 missing credentials produce visible error; AI-6-03 cancellation works; AI-6-04 results carry provenance/caching metadata.  
   Effort: 1 week. Uncertain: provider and product policy.

7. **6.7 Phase 6 Audit**  
   Audit FFI, service security, Python execution, connector credentials, AI data flow, and binding consistency.  
   Acceptance: A6-01 all gates green; A6-02 binding smoke matrix green; A6-03 security review checked in; A6-04 no unpinned deps.  
   Effort: 4-6 days.

**Audit Checkpoints**

- Security/design audit after 6.1 before exposing service/bindings.
- Full audit after 6.6.

**IDE Proof Points**

- IDE uses the Node binding or service path intended for v1.
- Python UDFs and AI() are callable from the IDE formula bar with cancellation and diagnostics.

**Exit Criteria**

- Product surfaces are real and tested.
- All bindings share one engine contract.
- Python UDFs, SQL/connectors, and AI() do not bypass graph invalidation.

**Documentation Deliverables**

- `docs/phase6/entry-plan.md`.
- `docs/phase6/exit-packet.md`.
- `docs/api/session-api.md`.
- `docs/security/udf-ai-connectors.md`.

## Phase 7 - Hardening And Ship

**Purpose:** Turn a feature-complete engine into a release candidate through performance hardening, observability, scale tests, audits, packaging, signing, and final IDE polish.

**Entry State Required**

- Phases 2B-6 complete.
- No major architecture holes hidden behind "later".

**Dependencies**

- Requires all product surfaces and IDE integration.
- Requires compatibility matrix and collaboration model to be stable.

**Sub-items**

1. **7.1 Observability And Diagnostics Freeze**  
   Standardize timings, graph profiles, cache stats, dirty counts, function errors, collaboration conflicts, and service logs.  
   References: `crates/ql-profile/src/{timings,graph_profile}.rs`; `.references/formualizer/crates/formualizer-eval/src/telemetry.rs`.  
   Acceptance: OBS-7-01 profile captures every critical runtime phase; OBS-7-02 IDE can show diagnostics; OBS-7-03 logs contain no secrets.  
   Effort: 3-5 days.

2. **7.2 Scale And Stress Suite**  
   Add reproducible stress tests: 1B-cell sparse workbook, 25M SIMD regions, large dependency chains, whole-column aggregates, xlsx corpus, collaboration fuzz, service soak.  
   References: `.references/formualizer/crates/formualizer-workbook/tests/large_sheets.rs`; `.references/formualizer/benchmarks/scenarios.yaml`; `crates/ql-bench/src/synthetic.rs`.  
   Acceptance: SCALE-7-01 1B-cell sparse workbook opens without dense allocation; SCALE-7-02 target perf envelopes documented; SCALE-7-03 CI has short smoke and long manual profiles.  
   Effort: 1 week.

3. **7.3 Performance Hardening**  
   Tune graph storage, range caches, overlays, SIMD kernels, service serialization, and binding overhead. No semantic changes without tests.  
   References: `.references/formualizer/crates/formualizer-eval/src/engine/delta_edges.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/csr_edges.rs`; `.references/formualizer/crates/formualizer-eval/src/arrow_store/mod.rs`; `.references/hyperformula/src/DependencyGraph/RangeMapping.ts`.  
   Acceptance: PERF-7-01 no regression against Phase 0 locked gates; PERF-7-02 dirty recompute budgets documented; PERF-7-03 memory profiles collected.  
   Effort: 1-2 weeks.

4. **7.4 Final IDE Polish**  
   Exercise real workflows: formula editing, paste, import/export, collaboration, UDFs, AI(), diagnostics, cancellation, and recovery.  
   References: Phase 2B/5/6 IDE proof docs; VS Code stock API constraints.  
   Acceptance: IDE-7-01 product walkthrough passes; IDE-7-02 no in-app fallback messages hiding engine errors; IDE-7-03 keyboard/mouse workflows usable.  
   Effort: 1 week.

5. **7.5 Release Artifacts, Signing, Distribution**  
   Build release artifacts for engine crates/bindings/service/IDE integration, signing, checksums, versioning, migration docs, and rollback.  
   References: repository build scripts; binding package configs; `.references/formualizer/.github/workflows/release.yml` for pattern only.  
   Acceptance: REL-7-01 reproducible release build; REL-7-02 artifacts signed/checksummed; REL-7-03 migration guide written; REL-7-04 rollback tested.  
   Effort: 1 week.

6. **7.6 Final Megaudit And Ship Decision**  
   Independent multi-agent review of correctness, security, performance, docs, legal provenance, and IDE integration.  
   Acceptance: SHIP-7-01 all gates green; SHIP-7-02 HIGH findings closed; SHIP-7-03 MEDIUM findings either closed or explicitly accepted; SHIP-7-04 release checklist signed.  
   Effort: 1 week.

**Audit Checkpoints**

- Pre-release audit after 7.4.
- Final ship audit after 7.5.

**IDE Proof Points**

- This phase owns the full product walkthrough and release candidate validation.

**Exit Criteria**

- Release artifacts exist.
- Scale and stress suite passes within documented envelopes.
- Final audit is closed or explicitly accepted.
- Docs are coherent from Phase 0 through v1.

**Documentation Deliverables**

- `docs/phase7/entry-plan.md`.
- `docs/phase7/exit-packet.md`.
- `docs/release/v1-checklist.md`.
- `docs/release/migration-and-rollback.md`.

## PART III - Cross-Cutting Policies

### 1. Reference-Source Policy

Use references deliberately. Do not cargo-cult them.

- Formualizer is the primary Rust systems reference for Arrow storage, overlays, range stripes, scheduling shape, transactions, bindings, and xlsx backend patterns. Key files: `.references/formualizer/crates/formualizer-eval/src/arrow_store/mod.rs`, `range_view.rs`, `engine/graph/range_deps.rs`, `engine/scheduler.rs`, `engine/delta_edges.rs`, `engine/csr_edges.rs`, `engine/spill.rs`.
- HyperFormula is GPLv3/commercial and therefore pattern-only. Use it for aggregate caches, prefix-tail concepts, value-equality propagation, parser cache shape, and dependency graph concepts. Key files: `.references/hyperformula/src/DependencyGraph/RangeVertex.ts`, `RangeMapping.ts`, `TopSort.ts`, `DependencyGraph.ts`, `parser/ParserWithCaching.ts`.
- IronCalc is the primary parser/function/Excel-semantics reference once Phase 4 starts. Key files: `.references/ironcalc/base/src/expressions/`, `.references/ironcalc/base/src/functions/`, `.references/ironcalc/base/src/formatter/`, `.references/ironcalc/base/src/implicit_intersection.rs`, `.references/ironcalc/base/src/test/`.
- Every non-trivial adopted implementation pattern needs a provenance note under `docs/legal/` before ship prep.
- If a reference contradicts the current plan, update the plan first. That is how CORR-21..25 happened.

### 2. Audit Cadence

- Dispatch an independent audit at every phase exit.
- Dispatch a megaudit at least every two phases; mandatory megaudits are Phase 3, Phase 4, Phase 5, and Phase 7.
- Phase 3 gets extra scrutiny because it merges the runtime and fast engine.
- Audits lead with HIGH findings. Do not bury correctness failures under summaries.
- Deferred findings require owner, target phase, and reason.

### 3. Doc Maintenance

- Every phase starts with `entry-plan.md` and ends with `exit-packet.md`.
- Every phase exit includes a doc-rot pass touching phase maps, this master plan if needed, audit index, compatibility matrix if relevant, and architecture docs.
- Stale docs are bugs. Phase 2 docs claiming 2A.3 is deferred are the current example.
- Dates must be concrete. Do not write "today" in canonical docs.

### 4. Test Discipline

- Each phase must add comprehensive tests. Aim for more than 2x test count over the phase when the phase changes product behavior; if that is unrealistic, write the exception in the exit packet.
- Every function gets arity, coercion, happy path, error, and edge tests.
- Every graph feature gets direct typed-map tests and runtime E2E tests.
- Every persistence feature gets save/load/replay tests.
- Every IDE proof gets at least one automated or scripted acceptance path.
- Long stress tests may be manual, but short smoke coverage must run in normal gates.

### 5. No-Fallbacks Enforcement

- Unsupported features return precise visible errors.
- No silent scalar fallback on hot paths unless the fallback is the correct semantic implementation and is profiled as such.
- No direct mutation bypass may exist in product paths without op-log/collab semantics.
- No import/export data loss is allowed without explicit warnings.
- No collaboration conflict may be auto-dropped without a documented deterministic policy.

### 6. IDE Feedback Loop

- Phase 2B proves the basic formula edit loop.
- Phase 3 proves incremental recompute and cycle diagnostics.
- Phase 4 proves xlsx, arrays, tables, cross-sheet refs, localization/R1C1 if enabled.
- Phase 5 proves two-peer collaboration.
- Phase 6 proves UDFs, AI(), service/binding path, cancellation.
- Phase 7 proves the full release walkthrough.

The IDE is not a late wrapper. It is how runtime contracts get falsified.

## PART IV - Open Questions To Resolve Early

1. **Where does graph state live permanently?**  
   Why this matters: putting graph state in `Workbook`, `WorkbookRuntime`, or a separate session object changes persistence, bindings, collab, and service APIs.  
   Decide by Phase 3.1.

2. **What is the exact `.qbook` schema boundary between user state, computed state, and op/collab state?**  
   Why this matters: computed-overlay separation, replay, and CRDT merge can corrupt each other if persisted ambiguously.  
   Decide by Phase 3.5.

3. **Do we support 1900 and 1904 date systems in v1, and how do we expose workbook policy?**  
   Why this matters: xlsx import/export and date functions cannot be Excel-compatible without a date-system policy.  
   Decide by Phase 4.5.

4. **Which xlsx writer do we ship?**  
   Why this matters: calamine is read-only; export quality and licensing depend on the writer choice.  
   Decide by Phase 4.11.

5. **How much localization is v1 versus post-v1?** **DECIDED at Phase 4.9 (W5-138 → W5-152, 2026-05-15).**  
   Why this matters: localized function names and separators affect parser, printer, IDE, and import/export.  
   **Decision:** v1 ships locale-aware SEPARATORS only (decimal, argument, array row, array col) for EnUs / De / Fr. Function-name localization is OUT-of-scope for v1 per LOC-4-02 reading. UTF-16 string semantics + locale-aware case mapping (UPPER/LOWER) also out-of-scope for Phase 4.9; awaiting a future Phase. See `docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md` § 2 (non-goals).

6. **What is the collaboration conflict policy for formula versus value concurrent edits?**  
   Why this matters: this is the common conflict and the easiest place to lose user work.  
   Decide by Phase 5.3.

7. **What transport is canonical for `ql-service`: HTTP, gRPC, or both?**  
   Why this matters: bindings, IDE integration, auth, streaming diagnostics, and cancellation depend on it.  
   Decide by Phase 6.2.

8. **What is the Python UDF sandbox guarantee?**  
   Why this matters: PyO3 can execute arbitrary Python; product security claims must be honest.  
   Decide by Phase 6.4.

9. **What provider and data policy backs AI()?**  
   Why this matters: AI() touches secrets, user data, cancellation, caching, and provenance.  
   Decide by Phase 6.6.

10. **Does `ql-terminal` remain in v1 scope?**  
    Why this matters: terminal-side surface is currently unclear and could consume binding/service time.  
    Decide by Phase 6 entry.

## PART V - Risk Register

| Risk | Severity | Trigger | Mitigation | Owning Phase |
|---|---|---|---|---|
| Runtime and calcgraph integration is harder than expected | Critical | Phase 3 cannot preserve current scalar behavior while graph-driving recompute | Stage graph ownership, dependency extraction, scheduler, and overlays separately; megaudit before Phase 4 | 3 |
| Map-order recompute corrupts dependency chains before Phase 3 | High | IDE or tests rely on chained formulas in Phase 2B | Add visible warning/known limitation in 2B; prioritize topological recompute in Phase 3 | 2B/3 |
| Range aggregate cache invalidation is wrong | High | Whole-column SUM returns stale values after edits | Start with conservative invalidation, then optimize; compare against scalar baseline | 3 |
| Computed/user overlay split breaks persistence | High | Save/load confuses typed user value and formula output | Schema tests for every cell state; explicit migration docs | 3 |
| Function expansion produces inconsistent coercion | High | Functions implement local coercion rules ad hoc | Central coercion matrix before broad function wave | 4 |
| Parser expansion breaks formula round-trip | High | R1C1/localization/tables introduce ambiguous printer output | Parser gap matrix, round-trip property tests, IronCalc deep-read first | 4 |
| XLSX export loses workbook data | High | Unsupported styles/tables/names silently dropped | No-fallback import/export policy; warnings and matrix entries | 4 |
| CRDT merge loses user edits | Critical | Offline peers edit same structures and one edit disappears | Formal conflict policy, randomized merge tests, collaboration audit | 5 |
| Op log and CRDT model diverge | High | Single-writer op log semantics are mistaken for collaborative history | Phase 5 model doc separates op history, CRDT state, and computed state | 5 |
| Python UDFs create unacceptable security exposure | Critical | UDFs can read/write host resources beyond policy | Honest sandbox policy, process isolation if required, security audit | 6 |
| AI() leaks sensitive workbook data | Critical | Provider boundary sends unintended context | Explicit marshalling, provenance, no-secret defaults, security review | 6 |
| Binding APIs fork behavior | High | WASM/Node/Python/C expose different semantics | Stable session API shared by all bindings | 6 |
| Scale target causes memory blowup | High | 1B-cell sparse workbook densifies storage or graph | Sparse stress suite and memory profiles before release | 7 |
| Dependency pin drift | Medium | New crates resolve unpinned versions | Workspace exact pins and `scripts/check-cargo-lock-pins.sh` updates in every phase | All |
| Doc rot misleads future sessions | Medium | Phase docs contradict shipped code | Phase-exit doc pass required; stale docs treated as bugs | All |

