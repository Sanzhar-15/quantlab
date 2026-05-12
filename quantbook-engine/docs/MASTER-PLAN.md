# Quantbook Engine Master Plan

**Status:** Canonical engine-side plan, post-Phase 2A.3  
**Date:** 2026-05-12  
**Current HEAD:** `fc977815cd2`  
**Scope:** engine-internal sequencing for all 24 workspace crates  
**Authored:** Claude Opus 4.7 + Codex (co-thinking session, 2026-05-12)

This is the long path. There is no MVP shortcut in this plan. The v1 target is a real spreadsheet engine backing Quantlab: correct scalar semantics, fast graph-driven recomputation, Excel coverage, collaboration, import/export, bindings, service mode, Python UDFs, SQL, connectors, AI(), and an exercised IDE integration.

---

## 0. How this document relates to the product master plan

There is a **canonical product master plan** for Quantbook at:

> `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md`

That document (dated 2026-05-10, 949 lines) is the **product source-of-truth**: the fusion thesis, the wedge, the v1 ship definition, the 11-phase / 9-12 month budget, the kill gates, the v1.5 deferrals, the legal posture, the renderer/Python/IDE phase plan. It is gitignored (lives outside this engine worktree). Future sessions should read it before making product-level decisions.

This `MASTER-PLAN.md` is the **engine-side execution plan**: how the Rust engine work proceeds from where it is today (HEAD `fc977815cd2`) through to a state where every product-plan phase that needs engine support has it. It uses engine-internal phase numbers (`2B`, `3`, `4`, `5`, `6`, `7`) that DO NOT align with the canonical plan's numbering (`Phase 0..10`).

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

The engine now has 816 workspace tests and 7 green gates. That is a floor, not a trophy. The major unresolved problem is that the "fast engine" (`ql-calcgraph`, SIMD region lowering, storage profiles) and the "runtime engine" (`WorkbookRuntime`, per-formula scalar path) still do not form one engine.

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

1. **3.1 Calcgraph Runtime Ownership Model**  
   Decide where graph state lives: likely inside `WorkbookRuntime` session state with persistable rebuild from workbook formulas, not inside `Workbook` storage alone. Define rebuild, mutation, and snapshot APIs.  
   References: `.references/formualizer/crates/formualizer-eval/src/engine/graph/mod.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/vertex_store.rs`; `.references/hyperformula/src/DependencyGraph/DependencyGraph.ts`.  
   Acceptance: G3-01 graph can rebuild from workbook deterministically; G3-02 graph mutation API covers set value, set formula, clear formula, set name, add sheet; G3-03 no petgraph hot-path dependency.  
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

4. **3.4 Tarjan SCC Scheduler And Full Topological Recompute**  
   Replace map-order recompute with dirty-subset Tarjan SCC plus deterministic layers. Cycles surface as Excel errors and diagnostics, not panics.  
   References: `.references/formualizer/crates/formualizer-eval/src/engine/scheduler.rs`; `.references/hyperformula/src/DependencyGraph/TopSort.ts`; `docs/phase0/references-reading-log.md` CORR-23.  
   Acceptance: SCH-3-01 dependency chains recompute correctly; SCH-3-02 cycle reports include SCC members; SCH-3-03 acyclic layers deterministic across runs; SCH-3-04 dirty subset recompute avoids unrelated formulas.  
   Effort: 5-7 days.

5. **3.5 Computed-Overlay Separation**  
   Split user edits from computed formula/spill outputs in storage. Reads cascade user -> computed -> base. User write clears stale computed value at that cell.  
   References: `.references/formualizer/crates/formualizer-eval/src/arrow_store/mod.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/range_view.rs`; `docs/phase0/references-reading-log.md` CORR-25.  
   Acceptance: OVR-3-01 formula output no longer mutates user overlay; OVR-3-02 typing over formula clears formula/computed state; OVR-3-03 save/load preserves correct semantic layer; OVR-3-04 range reads see cascade consistently.  
   Effort: 4-7 days.

6. **3.6 Range Aggregate Cache V1**  
   Add aggregate cache nodes for SUM/COUNT/MIN/MAX/AVERAGE/PRODUCT over range plans, invalidated by dirty stripes. Start simple: clear relevant aggregate cache on intersecting writes; optimize later.  
   References: `.references/hyperformula/src/DependencyGraph/RangeVertex.ts`; `.references/hyperformula/src/DependencyGraph/RangeMapping.ts`; `.references/formualizer/crates/formualizer-eval/src/engine/tests/compressed_range_scheduler.rs`.  
   Acceptance: AGG-3-01 `SUM(A1:A100000)` does not rescan full range on unrelated writes; AGG-3-02 intersecting write invalidates; AGG-3-03 full-column aggregate remains compressed; AGG-3-04 results match scalar baseline.  
   Effort: 5-8 days. Uncertain: cache representation may need revision after storage overlay split.

7. **3.7 Volatile Function Invalidation**  
   Model NOW/RAND/RANDBETWEEN and later volatile functions as graph roots invalidated by recompute cycle, edit, or explicit recalc mode. Add deterministic test mode.  
   References: `.references/formualizer/crates/formualizer-eval/src/rng.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/tests/volatile_rng.rs`; `.references/ironcalc/base/src/functions/math_and_trigonometry/random.rs`.  
   Acceptance: VOL-3-01 volatile formulas recompute when requested; VOL-3-02 nonvolatile dependents update if volatile value changes; VOL-3-03 deterministic RNG test fixture exists.  
   Effort: 2-4 days.

8. **3.8 Value-Equality Short-Circuit**  
   If a recomputed value is equal to the previous visible value, do not dirty downstream dependents beyond what is already required. Equality must respect Excel errors, blanks, numbers, text, bools, and dates.  
   References: `.references/hyperformula/src/DependencyGraph/TopSort.ts`; `.references/hyperformula/src/interpreter/InterpreterValue.ts`; `crates/ql-types/src/value.rs`.  
   Acceptance: VEQ-3-01 unchanged upstream suppresses downstream recompute; VEQ-3-02 error equality is correct; VEQ-3-03 profile records skipped downstream vertices.  
   Effort: 2-4 days.

9. **3.9 SIMD Region Through Graph Runtime**  
   Ensure region-style lowering and direct Arrow kernels are invoked from the graph scheduler rather than separate bench-only paths.  
   References: `.references/formualizer/crates/formualizer-eval/src/stripes.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/range_view.rs`; `crates/ql-exec/src/{lower,simd}.rs`.  
   Acceptance: SIMD-3-01 OG-02 path still hits multiversion kernels; SIMD-3-02 scalar fallback is explicit only for unsupported semantics such as div-by-zero-sensitive division; SIMD-3-03 graph profile shows region execution.  
   Effort: 3-6 days.

10. **3.10 Phase 3 Megaudit**  
    Independent audit of graph correctness, scheduler cycles, storage overlays, dirty propagation, aggregate invalidation, and perf regressions.  
    Acceptance: A3-01 all 7 gates green; A3-02 dependency-chain correctness locked; A3-03 10k-formula dirty recompute benchmark checked in; A3-04 test count at least 2x Phase 2B exit count or documented exception.  
    Effort: 3-5 days.

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

**Dependencies**

- Array formulas, spills, structured references, xlsx formula load, and cross-sheet recalculation depend on Phase 3 graph integration.
- IronCalc deep-read is mandatory at Phase 4 start.

**Sub-items**

1. **4.1 IronCalc Parser Deep-Read And Parser Gap Matrix**  
   Read IronCalc parser and lexer in the deferred order, then write a Quantbook parser gap matrix.  
   References: `.references/ironcalc/base/src/expressions/parser/mod.rs`; `.references/ironcalc/base/src/expressions/lexer/mod.rs`; `.references/ironcalc/base/src/expressions/parser/static_analysis.rs`; `.references/ironcalc/base/src/expressions/parser/stringify.rs`; `.references/ironcalc/base/src/expressions/parser/move_formula.rs`.  
   Acceptance: PAR-4-01 gap matrix checked in; PAR-4-02 no parser expansion begins before this document exists; PAR-4-03 legal/provenance notes updated.  
   Effort: 2-4 days.

2. **4.2 Excel Compatibility Matrix Harness**  
   Create a checked-in matrix for functions, operators, coercions, errors, arrays, tables, date systems, localization, and xlsx import/export.  
   References: `.references/formualizer/benchmarks/function_matrix.yaml`; `.references/formualizer/benchmarks/harness/runner/schema.py`; `.references/ironcalc/base/src/test/`.  
   Acceptance: ECM-4-01 matrix exists; ECM-4-02 each function has status, tests, category, and Excel parity notes; ECM-4-03 CI can report coverage percentage.  
   Effort: 2-3 days.

3. **4.3 Function Library Expansion Wave 1 - Core 100**  
   Implement high-use math, logical, text, lookup, statistical, date/time, and information functions. Include metadata for volatility, laziness, array behavior, and argument coercion.  
   References: `.references/ironcalc/base/src/functions/mod.rs`; `.references/ironcalc/base/src/functions/math_and_trigonometry/`; `.references/ironcalc/base/src/functions/statistical/`; `.references/formualizer/crates/formualizer-eval/src/function_registry.rs`.  
   Acceptance: FN4-01 at least 100 total functions implemented; FN4-02 every function has positive, error, coercion, and arity tests; FN4-03 IF/IFERROR lazy eval fixed; FN4-04 matrix updated.  
   Effort: 2-3 weeks.

4. **4.4 Coercion And Error Semantics Matrix**  
   Centralize coercion rules and error precedence. Lock binary op behavior, function argument coercion, blank handling, text-to-number, and date serial behavior.  
   References: `.references/ironcalc/base/src/cast.rs`; `.references/ironcalc/base/src/calc_result.rs`; `.references/formualizer/crates/formualizer-eval/src/coercion.rs`; `.references/hyperformula/src/interpreter/InterpreterValue.ts`.  
   Acceptance: COER-4-01 matrix checked in; COER-4-02 arithmetic, comparison, aggregate, logical, and text coercion cases covered; COER-4-03 no silent fallback for unsupported variants.  
   Effort: 1-2 weeks.

5. **4.5 Dates, Times, Number Formats**  
   Implement serial date systems, time arithmetic, display formatting, parse formatted numbers, and locale-sensitive format tokens.  
   References: `.references/ironcalc/base/src/formatter/`; `.references/ironcalc/base/src/functions/date_and_time.rs`; `.references/formualizer/crates/formualizer-workbook/tests/calamine/dates.rs`.  
   Acceptance: DTF-4-01 1900/1904 policy explicit; DTF-4-02 date/time functions match matrix; DTF-4-03 number format parser tests include en/de/fr examples; DTF-4-04 storage distinguishes value from display format.  
   Effort: 1-2 weeks.

6. **4.6 Cross-Sheet References And Sheet-Scoped Names**  
   Extend AST/binder/runtime to support `Sheet1!A1`, quoted sheet names, 3D constraints if chosen, and sheet-scoped names.  
   References: `.references/ironcalc/base/src/expressions/lexer/ranges.rs`; `.references/ironcalc/base/src/expressions/parser/tests/test_ranges.rs`; `.references/hyperformula/src/DependencyGraph/SheetMapping.ts`; `.references/formualizer/crates/formualizer-eval/src/engine/graph/sheets.rs`.  
   Acceptance: XS-4-01 cross-sheet cell refs parse, print, bind, and recompute; XS-4-02 quoted names work; XS-4-03 sheet-scoped names resolve before workbook-scoped names; XS-4-04 op-log and xlsx paths preserve sheet identity.  
   Effort: 1 week.

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

9. **4.9 R1C1, Localization, Implicit Intersection**  
   Add mode-aware parsing/printing for R1C1, localized separators/function names where required, and implicit intersection semantics.  
   References: `.references/ironcalc/base/src/expressions/lexer/test/test_locale.rs`; `.references/ironcalc/base/src/expressions/parser/tests/test_locales.rs`; `.references/ironcalc/base/src/implicit_intersection.rs`; `.references/ironcalc/base/src/expressions/parser/tests/test_implicit_intersection.rs`; `.references/hyperformula/src/parser/addressRepresentationConverters.ts`.  
   Acceptance: LOC-4-01 R1C1 parser/printer round-trips; LOC-4-02 localized separators covered; LOC-4-03 implicit intersection added where Excel requires it; LOC-4-04 IDE can toggle formula display mode.  
   Effort: 1-2 weeks.

10. **4.10 Function Library Expansion Wave 2 - V1 260**  
    Finish the v1 function target. Defer only with explicit product sign-off and matrix entries.  
    References: `.references/ironcalc/base/src/functions/`; `.references/formualizer/benchmarks/function_matrix.yaml`; `.references/hyperformula/src/interpreter/FunctionRegistry.ts`.  
    Acceptance: FN4-260-01 roughly 260 target functions implemented or explicitly cut; FN4-260-02 every implemented function has matrix-backed tests; FN4-260-03 unsupported functions produce visible errors.  
    Effort: 3-5 weeks.

11. **4.11 XLSX Import/Export**  
    Make `ql-io-xlsx` real: workbook load, formulas, cached values, names, sheets, tables, formats, date systems, and export. Start with calamine for read; choose writer deliberately.  
    References: `.references/formualizer/crates/formualizer-workbook/src/backends/calamine.rs`; `.references/formualizer/crates/formualizer-workbook/src/backends/umya.rs`; `.references/formualizer/crates/formualizer-testkit/src/xlsx.rs`; `.references/ironcalc/base/src/model.rs`.  
    Acceptance: XLSX-4-01 import common workbooks; XLSX-4-02 formulas recalc through graph; XLSX-4-03 names/tables/formats survive round-trip where supported; XLSX-4-04 corruption and unsupported features surface visible errors.  
    Effort: 2-4 weeks.

12. **4.12 Phase 4 Megaudit And Compatibility Freeze**  
    Audit parser, functions, arrays, tables, xlsx, and compatibility matrix.  
    Acceptance: A4-01 all gates green; A4-02 compatibility matrix is complete enough to guide users; A4-03 Excel corpus smoke suite green; A4-04 test count at least 2x Phase 3 exit count or exception documented.  
    Effort: 4-6 days.

**Audit Checkpoints**

- Parser audit after 4.1-4.2.
- Megaudit after 4.11.

**IDE Proof Points**

- IDE must open an imported `.xlsx`, show formulas, edit formulas, save `.qbook`, and export `.xlsx`.
- Formula bar must handle cross-sheet refs, arrays/spills, and localized/R1C1 modes if enabled.

**Exit Criteria**

- Excel compatibility matrix exists and drives work.
- Function target is reached or explicitly adjusted.
- xlsx import/export works for v1 corpus.
- Arrays/spills/tables/cross-sheet references are graph-integrated.

**Documentation Deliverables**

- `docs/phase4/entry-plan.md`.
- `docs/phase4/exit-packet.md`.
- `docs/compat/excel-matrix.md`.
- `docs/architecture/parser-and-semantics.md`.
- Updated legal/provenance notes.

## Phase 5 - Multi-User CRDT Collaboration

**Purpose:** Turn collaboration from a single-writer op log into real multi-user CRDT state for sheets, cells, names, tables, presence, undo/redo, and offline sync.

**Entry State Required**

- Phase 3 graph runtime exists.
- Phase 4 semantics are broad enough that collaboration does not need to redesign value/formula/table structures.

**Dependencies**

- Requires stable operation vocabulary from `ql-oplog`.
- Requires storage semantics for computed versus user state.
- Requires IDE proof surface for multi-user presence.

**Sub-items**

1. **5.1 Collaboration Data Model Decision**  
   Define which entities are Loro documents/maps/lists: workbook metadata, sheets, cells, formulas, names, tables, formats, and presence. Decide how computed values are derived rather than merged.  
   References: Loro docs through pinned crate examples; `crates/ql-oplog/src/op.rs`; `.references/hyperformula/src/Serialization.ts` for separation of model/evaluation state.  
   Acceptance: COL-DM-01 model doc checked in; COL-DM-02 computed state excluded from authoritative CRDT merge; COL-DM-03 conflict policy documented per entity.  
   Effort: 3-5 days. Uncertain: final Loro container shape.

2. **5.2 `ql-collab` Core Documents**  
   Implement collaborative workbook document, import/export, peer merge, version vectors, and conversion to/from `Workbook`.  
   References: `ql-oplog` persistence; `.references/formualizer/crates/formualizer-workbook/src/session.rs`; `.references/formualizer/crates/formualizer-sheetport/src/session.rs`.  
   Acceptance: DOC5-01 two docs merge cells/names/sheets; DOC5-02 deterministic materialization; DOC5-03 corrupt/unsupported CRDT state errors visibly.  
   Effort: 1-2 weeks.

3. **5.3 Conflict Resolution Semantics**  
   Define last-writer, multi-value, delete/update, formula/value, sheet rename, and name collision behavior. Add conflict diagnostics where user action is required.  
   References: `crates/ql-oplog/src/replay.rs`; `.references/formualizer/crates/formualizer-workbook/src/transaction.rs`; `.references/hyperformula/src/CrudOperations.ts`.  
   Acceptance: CON-5-01 formula/value concurrent edits deterministic; CON-5-02 sheet/name conflicts deterministic; CON-5-03 conflicts visible in IDE diagnostics.  
   Effort: 4-7 days.

4. **5.4 Undo/Redo And Operation Grouping**  
   Build local undo/redo over collaborative ops without corrupting remote history. Transaction commits remain one undo unit.  
   References: `.references/formualizer/crates/formualizer-eval/src/engine/graph/snapshot.rs`; `.references/formualizer/crates/formualizer-sheetport/src/batch.rs`; `.references/hyperformula/src/CrudOperations.ts`.  
   Acceptance: UND-5-01 local undo reverts local transaction; UND-5-02 remote edits remain; UND-5-03 redo works after sync where valid; UND-5-04 impossible redo reports visible conflict.  
   Effort: 1 week.

5. **5.5 Transport Layer And Offline Sync**  
   Implement WebSocket transport, file/session identity, offline queue, reconnect merge, and backpressure policy.  
   References: `.references/formualizer/crates/formualizer-sheetport/src/session.rs`; `tokio` pinned workspace deps; VS Code stock WebSocket-compatible APIs.  
   Acceptance: NET-5-01 two peers sync online; NET-5-02 offline edits merge after reconnect; NET-5-03 transport errors do not lose local edits; NET-5-04 protocol version mismatch is explicit.  
   Effort: 1-2 weeks.

6. **5.6 Presence And Awareness**  
   Add cursor/selection/user metadata presence as ephemeral collaboration state. Presence must not dirty workbook graph.  
   References: VS Code APIs; Loro awareness examples if available; `.references/formualizer/crates/formualizer-sheetport/src/session.rs`.  
   Acceptance: PRE-5-01 remote selections show in IDE; PRE-5-02 presence expires; PRE-5-03 presence never persists into `.qbook` as workbook data.  
   Effort: 3-5 days.

7. **5.7 Collaboration IDE Vertical Slice**  
   Two IDE windows edit one workbook, go offline, edit conflicting cells/names, reconnect, and resolve/display conflicts.  
   References: Phase 2B IDE slice; Phase 3 graph diagnostics.  
   Acceptance: IDE-5-01 two-window sync; IDE-5-02 offline reconnect; IDE-5-03 conflict diagnostics; IDE-5-04 undo/redo works with remote edits.  
   Effort: 1 week.

8. **5.8 Phase 5 Megaudit**  
   Audit CRDT merge soundness, data loss risks, transport failure modes, and security boundaries.  
   Acceptance: A5-01 all gates green; A5-02 randomized peer-merge tests checked in; A5-03 no silent conflict drops; A5-04 test count discipline met.  
   Effort: 4-6 days.

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

- `docs/phase5/entry-plan.md`.
- `docs/phase5/exit-packet.md`.
- `docs/architecture/collaboration-crdt.md`.
- Protocol/versioning notes.

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

5. **How much localization is v1 versus post-v1?**  
   Why this matters: localized function names and separators affect parser, printer, IDE, and import/export.  
   Decide by Phase 4.9.

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

