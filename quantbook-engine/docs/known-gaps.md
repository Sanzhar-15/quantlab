# Known engine gaps — checklist with target phases

**Status:** Living document, updated at each phase boundary  
**Date last touched:** 2026-05-13 (Engine Phase 4 pre-V2 — W5-52: mega-audit closure for W5-50 clear-formula path + GAP-F-05 filed)  
**Companion:** `docs/MASTER-PLAN.md`

Every gap below carries a target Engine phase per `docs/MASTER-PLAN.md`. When a gap is closed, move its row to the "Closed" section at the bottom and reference the closing commit.

## Open gaps (post-Phase 2A.3)

### Runtime / evaluation

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-R-01 | `recompute_all` STILL walks formulas in `HashMap`-arbitrary order — it's the full-pass legacy path. Phase 3.4 (2026-05-12) added `WorkbookRuntime::recompute_dirty()` which uses Tarjan SCC over the dirty subset (correct order for chains, `#CIRC!` for cycles). The IDE / consumer should migrate from `recompute_all` to `recompute_dirty` for incremental editing. `recompute_all` remains useful for fresh-load full passes. | `ql-exec/src/workbook_runtime.rs::recompute_all` vs `recompute_dirty` | Engine | Engine Phase 6.1 (`WorkbookSession`) decides if `recompute_all` is renamed / deprecated when the session contract lands. |
| ~~GAP-R-02~~ | ~~`recompute_all` short-circuits on first failure~~ — **CLOSED** in Engine Phase 2B.2 (commit `393ce2f765f`): replaced with `RecomputeResult` aggregating per-cell failures. |
| ~~GAP-R-03~~ | ~~Bind-plan re-derived from formula text on every recompute~~ — **CLOSED** in Engine Phase 2B.3 (commit `bd3147a1045`): `PlanCache` keyed by `(formula_text, sheet, name_gen)` on the runtime; `recompute_all` second-pass is all hits; name mutations bump generation and invalidate; counters exposed via `runtime.cache_stats()` + `Timings::bind_plan_cache_hits/misses`. |
| ~~GAP-R-04~~ | ~~Volatile functions have no invalidation model~~ — **CLOSED** in Engine Phase 3.7 (W5-40, commit-after-c4ecf389898). `CalcgraphSession::mark_volatile_dirty()` adds every volatile formula to the dirty set + fans out the reverse-dep BFS so downstream formulas recompute too. NOW/TODAY/RAND/RANDBETWEEN registered in `default_registry`; deterministic test mode via `ql_functions::set_test_rng_seed` + `set_test_now_secs`. RANDARRAY/INDIRECT/OFFSET/INFO/CELL deferred to Phase 4.3. |
| ~~GAP-R-05~~ | ~~Value-equality short-circuit not implemented~~ — **CLOSED** in Engine Phase 3.8 (W5-41, commit-after-83cb3d3c5de). `recompute_dirty` now snapshots prior values, evaluates in topo order, and skips formulas whose direct cell deps all stayed unchanged. `RecomputeResult.skipped_value_equality` exposes the count. Volatile + range-dep formulas bypass the skip (always re-eval). |
| GAP-R-08 | Phase 3.10 megaudit M1: volatile dependents diverge from Excel-canon. A non-volatile formula `=NOW() + 1` recomputes when NOW changes, but Phase 3.8 VEQ can skip its downstream if the NOW value happened to equal its prior. Excel canonically recomputes ALL volatile dependents every recalc cycle regardless of value. Today: only matters once side-effecting UDFs or recalc-counter observability lands. | `ql-exec/src/workbook_runtime.rs::recompute_dirty` — VEQ skip applies uniformly even to outputs of volatile formulas | Engine | Engine Phase 4.3 (function library expansion when volatile semantics tighten) or post-v1 |
| GAP-R-06 | `PlanCache` lives on `WorkbookRuntime`, which is per-edit. The documented IDE pattern drops the runtime after each edit → drops the cache. Phase 2B.3 cache observability is real only across one long-lived runtime/recompute block. | `ql-exec/src/workbook_runtime.rs::WorkbookRuntime` + `docs/architecture/ide-consumer-contract.md` §1 | Engine | Engine Phase 6.1 (`WorkbookSession`) moves cache ownership to the session. |
| GAP-R-07 | Phase 3.2 dep extraction loses the name when a `NameRef` resolves to `NamedTarget::Constant` or `NamedTarget::Cell` — the binder substitutes the value/CellRef and the source name does not appear in `ExprPlan` (so `CalcgraphSession::name_to_formulas` does not see it). Today the `PlanCache.name_gen` counter (Phase 2B.3) invalidates ALL formulas on any name mutation, so correctness is preserved; only the per-name precision is missing. Phase 3.3 wired `on_set_name` → `name_to_formulas`, which works for AggregateNameRef; this gap covers the scalar-NameRef precision miss that Phase 3.3 explicitly did NOT address. | `ql-exec/src/calcgraph_session.rs` module docs (§ "Still deferred"); `ql-exec/src/plan.rs::bind_with_names` scalar-NameRef branches | Engine | Engine Phase 4 (NameRef preservation in ExprPlan + binder revision) |

### Bind / semantics

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| ~~GAP-B-01~~ | ~~Named-range BIND surface for aggregate context~~ — **FULLY CLOSED** in Engine Phase 3.6 (W5-39, commit-after-18b19cbc4b5). Phase 2B.4 added the bind shape (`ExprPlan::AggregateNameRef`); Phase 3.6 adds the actual evaluator: SUM/AVERAGE/MIN/MAX/COUNT/PRODUCT over a single named-range arg now compute the real aggregate (via `CellEnv::read_range` clamped to `Sheet::bounds`) instead of `#CALC!`. Cache + invalidation also shipped (AGG-3-01..04). |
| GAP-B-02 | Named-formula targets (`Profit = Revenue - Costs`) — same `UnsupportedVariant` | None tested yet; parser doesn't even encounter | Engine | Engine Phase 4 |
| GAP-B-03 | Sheet-scoped names (`Sheet1!Local`) — NameTable has no per-sheet scope | `ql-storage/src/workbook.rs::NameTable` is workbook-flat | Engine | Engine Phase 4.6 |
| GAP-B-04 | Cross-sheet cell references (`Sheet2!A1`) — parser supports, binder does not resolve | `ql-formula-syntax::Expr::CellRef` carries sheet id but binder ignores cross-sheet at eval | Engine | Engine Phase 4.6 |
| GAP-B-05 | Bare range as scalar operand (`A1:A10`) surfaces as `UnsupportedVariant` — correct in scalar context, wrong if aggregate caller | `ql-exec/src/workbook_runtime.rs::tests::set_formula_named_range_target_unsupported` | Engine | Engine Phase 4.7 (array context) |

### Op log

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| ~~GAP-O-01~~ | ~~`Workbook::set_name` bypass~~ — **CLOSED** in commit-after-f64ff00dcb1 (Engine Phase 2B.5): `WorkbookRuntime::set_name` wrapper emits `Op::SetName`; `Workbook::set_name` doc-marked as low-level. Mutate-first ordering guards against ghost-op-on-reserved-name. |
| ~~GAP-O-02~~ | ~~`Workbook::add_sheet` bypass~~ — **CLOSED** in commit-after-f64ff00dcb1: `WorkbookRuntime::add_sheet(name, chunk_rows)` wrapper emits `Op::AddSheet`. Direct `Workbook::add_sheet` / `add_sheet_with_chunk_rows` doc-marked as low-level (used by qbook loader). |
| ~~GAP-O-03~~ | ~~Direct `put_at` / `clear_formula` bypass~~ — **CLOSED** in commit-after-f64ff00dcb1: `WorkbookRuntime::clear_formula` wrapper emits `Op::PutValue(current) + Op::ClearFormula` (preserves "strip formula, keep value" semantic across replay). Direct `Workbook::put_at` / `clear_formula` doc-marked as low-level. `Workbook::put_at` remains pub for the qbook loader + runtime-internal recompute pass 2 + tests; product code routes through `WorkbookRuntime::set_value`. |
| GAP-O-04 | `set_value(Value::Blank)` emits no `PutValue` (CellWireValue lacks Blank variant). `clear_formula` has the same Blank-skip behavior on the preserved-value op. Documented limitation. | `ql-exec/src/workbook_runtime.rs::set_value` + `::clear_formula` comments | Engine | Engine Phase 5 (CRDT model) or earlier if forced |
| GAP-O-05 | NaN / Inf in `PutValue` — `serde_json` refuses; surfaces as `RuntimeError::OpLog` | `ql-oplog/src/log.rs::append` serialization path | Engine | Engine Phase 5 or earlier |
| GAP-O-06 | Op log has no compaction/truncation strategy — unbounded growth on edit-heavy workbooks. Loro snapshot export compresses but retains full history. | `ql-oplog/src/log.rs` (no compaction API); no compaction in any MASTER-PLAN phase | Engine | Engine Phase 5 (CRDT collab re-examines op-log model) |

### Storage

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| ~~GAP-S-01~~ | ~~Single overlay per chunk (user + formula outputs share state)~~ — **CLOSED** in Engine Phase 3.5 (commit-after-645c7baf3bf, W5-38). `ColumnStore` now carries parallel `user_overlays` + `computed_overlays` per chunk; read cascade is user → computed → base; `put` (user) clears computed at the row, `put_computed` clears user. Runtime + qbook loader updated to route writes correctly. |
| GAP-S-02 | Float64-only base lane; no Boolean/Text/Error/DateTime column types | `ql-storage/src/column.rs::ColumnStore` holds `Vec<ArrayRef>` typed Float64 | Engine | Engine Phase 4.5 (date/time + format) onward, finalized in Phase 4 |
| GAP-S-03 | No type-tag byte per row; cell type comes from `Value` overlay only | Same — base array is Float64, overlay is `Value` | Engine | Engine Phase 4 (mixed types) |
| GAP-S-04 | No table metadata in storage; `Table[Column]` parse → bind path absent | `ql-storage` has no `Table` type | Engine | Engine Phase 4.8 (tables + structured refs) |
| GAP-S-05 | No styles / formatting / conditional formatting in storage | None — feature absent | Engine | Engine Phase 4 (formatting) + Canonical Phase 7 (UI) |
| GAP-S-06 | Phase 3.10 megaudit M3: qbook loader skips the value write for formula cells whose loaded value is `Value::Blank` (Pending), so `Sheet::bounds` doesn't grow to include the formula cell's position. Recompute later produces a real value, but plain load + render-without-recompute can miss formula-only-blank cells at the workbook fringe. | `ql-io/src/qbook_format.rs::load_workbook` formula branch | Engine | Engine Phase 4.5 (date/time + format) or earlier if the IDE forces render-without-recompute |

### Persistence

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-P-01 | Plain `save_workbook` (no oplog) drops existing `oplog.bin` if present in target — documented behavior | `ql-oplog/src/persistence.rs::tests::save_workbook_without_oplog_drops_existing_oplog_bin` | Engine | Documented limitation; revisit if IDE forces preservation policy |
| GAP-P-02 | xlsx import / export not implemented (stub crates only) | `ql-io-xlsx`, `ql-io-ods` are 15-line stubs | Engine | Engine Phase 4.11 (xlsx) + post-v1 (ods) |
| GAP-P-03 | NamedTarget::Constant(Value::Blank) wire-format ambiguity (conflates with formula-Pending) — cycle-3 audit M7 deferred | `ql-io/src/qbook_format.rs::NamedTargetWire::Constant` | Engine | Engine Phase 4 (when wire format gets a freeze pass) |
| GAP-P-04 | Concurrent save-from-two-processes — only temp-suffix isolation; no inter-process file locking | `ql-io/src/qbook_format.rs::save_session_suffix` | Engine | Post-v1 unless real users hit it |

### Function library

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-F-01 | 22 of ~260 v1 target functions implemented (8.4%) | `ql-functions/src/registry.rs::default_registry` count | Engine | Engine Phase 4.3 (wave 1, 100 fns) + 4.10 (wave 2, 260) |
| GAP-F-02 | `IF` / `IFERROR` evaluate both branches eagerly (no lazy arg semantics) | `ql-functions/src/registry.rs` — no lazy arg support; megaudit M7 deferred | Engine | Engine Phase 4.3 |
| GAP-F-03 | No Excel compatibility matrix (functions, coercions, errors, dates) | Doc absence | Engine | Engine Phase 4.2 (matrix harness) |
| GAP-F-04 | No NIST `numacc4` extreme test fixture for Welford stats | `ql-functions/src/welford.rs` covers numacc3 only | Engine | Post-v1 stats hardening |
| GAP-F-05 | **`ScalarFn = fn(&[Value]) -> Value` cannot carry range-vs-scalar argument metadata.** Filed W5-52 (audit closure): blocks the range-aware Phase 4.3 V2 batch — SUMIF / COUNTIF / SUMIFS / AVERAGEIF / SUMPRODUCT / VLOOKUP / HLOOKUP / MATCH / INDEX / CHOOSE. Existing aggregates (SUM, AVERAGE, MIN/MAX, COUNT) work because the eval-time dispatch (`scalar.rs::eval_scalar_with_cache`) special-cases single `AggregateNameRef` args and flattens to `Vec<Value>` before calling the registry; but per-argument range identification is lost. Needs either (a) a wider signature like `enum FnArg { Scalar(Value), Range(Vec<Value>) }` migrated across all ~60 entries, or (b) per-function evaluator special-casing (technical debt). Surfaced by both Codex + Sonnet in the W5-49 mega-audit. The W5-49 decision doc's stop-condition list mentioned FormulaRegion-for-semantics but missed this narrower function-dispatch problem. | `ql-functions/src/registry.rs::ScalarFn`; `ql-exec/src/scalar.rs::eval_scalar_with_cache` (line ~135) | Engine | Engine Phase 4.3 (must ship BEFORE V2 range-aware batches; scalar-only V2 batches like W5-51 trig are fine under existing contract) |

### Parser / syntax

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-X-01 | IronCalc parser never deep-read; expansion into structured refs / R1C1 / array literals / localization is unjustified without it | `docs/phase0/references-reading-log.md:530` (CORR-20) | Engine | Engine Phase 4.1 (IronCalc read + parser gap matrix) BEFORE any parser expansion |
| GAP-X-02 | Array formulas / spill anchors — AST has `Expr::Array` and `Expr::Spill` placeholders, no implementation | `ql-formula-syntax/src/ast.rs` placeholder variants | Engine | Engine Phase 4.7 |
| GAP-X-03 | Structured references (`Table[Column]`) not parsed | No lexer support; depends on GAP-S-04 | Engine | Engine Phase 4.8 |
| GAP-X-04 | R1C1 mode not supported | No mode flag in parser | Engine | Engine Phase 4.9 |
| GAP-X-05 | Localization (separators, function names) not supported | Hardcoded `,` / English fn names | Engine | Engine Phase 4.9 |
| GAP-X-06 | Implicit intersection not implemented | Excel-canon feature absent | Engine | Engine Phase 4.9 |

### Calcgraph

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-G-02 | Phase 3.9 V1 ships SIMD-eligibility OBSERVABILITY (`RecomputeResult.simd_classified` counts dirty formulas matching a recognized `SimdShape`) but NOT actual bulk SIMD dispatch from the graph scheduler. Per-formula scalar eval still runs even for SIMD-eligible plans; the bench / FormulaRegion path is the only one that drives multiversion kernels at bulk. Real region-style batched dispatch needs FormulaRegion-binder + region detection at write time — Phase 4.7+ array-formula work. | `ql-exec/src/workbook_runtime.rs::try_recompute_with_simd_profile` — classify returns shape but eval still routes through `eval_scalar_with_cache` | Engine | Engine Phase 4.7 (array formulas + FormulaRegion binder) or earlier follow-up under 3.10 megaudit |
| ~~GAP-G-01~~ | ~~Rebind staleness — stale forward edges + stale stripe registrations after formula text changed.~~ — **CLOSED in Engine Phase 4 pre-V2 (W5-50 rebind path + W5-52 clear-formula path).** `Graph::clear_outgoing` revokes the formula's outgoing edges + symmetric back-pointers in O(out_degree + Σ in_degree); `Graph::clear_range_deps_for_formula` revokes the formula's `formula_to_range_deps` entry + every stripe membership via `StripeIndex::clear_for_formula` (backed by reverse-lookup `formula_to_stripe_keys` for O(stripes-this-formula-is-in) cost). Wired into `calcgraph_session::extract_and_register_deps` (W5-50) AND `calcgraph_session::on_clear_formula` (W5-52 audit closure — the clear path was missed in W5-50 and caught by both Codex + Sonnet mega-audit). 13 graph-level tests + 7 session-level acceptance tests (rebind_clears_graph_outgoing_edges, h3_no_false_circ_after_rebind_to_constant, h4_rebind_clears_stale_range_stripe_dirty, rebind_to_same_plan_yields_same_graph_state, clear_formula_revokes_outgoing_graph_edges, clear_formula_revokes_range_stripes, clear_formula_then_no_phantom_cycle). |
| ~~GAP-G-03~~ | ~~Range deps not scheduler edges — `register_range_dependency` populated stripes + precision map but never `add_edge`. Tarjan invisible to range-induced ordering / cycles.~~ — **CLOSED in Engine Phase 4 pre-V2 (W5-50).** `topo::schedule_with_supplemental` accepts a `HashMap<NodeId, Vec<NodeId>>` of temp adjacency layered on top of `graph.outgoing(v)`. `CalcgraphSession::build_range_supplemental` builds it at schedule_dirty time: for each dirty formula `F` with range deps, for each OTHER dirty FORMULA node `G` whose address is inside one of F's ranges, push `G` into `supplemental[F]`. Scope: dirty formula nodes only (Codex W5-49 refinement). 7 Tarjan-level supplemental tests + 4 session-level acceptance tests (h1_range_induced_cycle_detected, h1_range_induced_ordering_via_supplemental, self_range_cycle_via_supplemental, partial_dirty_literal_in_range_no_supplemental). |

### Collaboration

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-C-01 | Loro op log is single-writer history, not multi-user CRDT state | `ql-oplog/src/log.rs` is append-only log only | Engine | Engine Phase 5.1 (collab data model decision) |
| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
| GAP-C-03 | `ql-collab` is a 15-line stub | `ql-collab/src/lib.rs` | Engine | Engine Phase 5.2 |
| GAP-C-04 | No undo/redo model defined; transactions exist but command grouping is informal | `ql-exec/src/transaction.rs` doesn't expose inverse ops | Engine | Engine Phase 5.4 |
| GAP-C-05 | No transport layer (WebSocket / offline sync) | Stub crate `ql-collab` empty | Engine | Engine Phase 5.5 |

### Product surfaces

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-PS-01 | `quantbook-py` Python binding stub only | `quantbook-py/src/lib.rs:15` | Engine | Engine Phase 6.3 |
| GAP-PS-02 | `ql-bindings-{wasm,node,c}` stubs only | Three stub crates | Engine | Engine Phase 6.3 |
| GAP-PS-03 | `ql-udf` (Python UDF execution) stub | `ql-udf/src/lib.rs:15` | Engine | Engine Phase 6.4 |
| GAP-PS-04 | `ql-sql` (DuckDB integration, `=DUCKDB(...)`) stub | `ql-sql/src/lib.rs` | Engine | Engine Phase 6.5 |
| GAP-PS-05 | `ql-connectors` (external data refresh) stub | `ql-connectors/src/lib.rs:15` | Engine | Engine Phase 6.5 |
| GAP-PS-06 | `ql-ai` (real AI() provider) stub; `AI()` returns AINotAvailable sentinel | `ql-ai/src/lib.rs:15`; `ql-functions::registry::AI` returns `Value::Error(ErrorValue::AINotAvailable)` | Engine | Engine Phase 6.6 |
| GAP-PS-07 | `ql-service` (engine-as-service transport) stub | `ql-service/src/lib.rs` | Engine | Engine Phase 6.2 |
| GAP-PS-08 | `ql-terminal` crate exists; product fit unclear (terminal-side surface for Delta Plus?) | `ql-terminal/src/lib.rs` | Product | Decide by Phase 6 entry |
| GAP-PS-09 | `WorkbookRuntime<'a>` carries lifetime parameters; Node-API / WASM bindings can't safely wrap it in a long-lived JS object. Need a `WorkbookSession` owning wb + oplog + registry + plan_cache without lifetimes. | `ql-exec/src/workbook_runtime.rs::WorkbookRuntime` (`<'a>` parameter) | Engine | Engine Phase 6.1 (Stable Engine Session API). Subsumes GAP-R-06. |

### IDE integration

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-I-01 | TypeScript-side `extensions/quantlab/` has never been exercised against the engine — separate worktree work. Engine side: contract + simulation **CLOSED** in Engine Phase 2B.6 (commit-after-66bbbddc3d9); see `docs/architecture/ide-consumer-contract.md` and `crates/ql-exec/tests/ide_simulation.rs`. TypeScript-side work belongs in the `quantlab/` main checkout. | `extensions/quantlab/` empty re: engine bindings | IDE worktree | Phase 2B.6 IDE side (separate session) |
| ~~GAP-I-02~~ | ~~No engine-side IDE-consumption test harness~~ — **CLOSED** in Engine Phase 2B.6: `crates/ql-exec/tests/ide_simulation.rs` (~270 lines, 7 tests) exercises the engine through the exact call pattern an IDE would use. Each test pins one IDE-2B-0N acceptance item. |
| GAP-I-03 | Diagnostic shape adequate but not exhaustive — error `Display` strings are user-facing per Phase 2A.11 audit M16 but lack span info (parser error doesn't say WHERE in the formula). | `RuntimeError::Display` outputs lack source position | Engine | Phase 2B.6 follow-up + Phase 7.4 (IDE polish) |
| ~~GAP-I-04~~ | ~~No dry-run formula validation API~~ — **CLOSED** in Engine Phase 2B.7 audit closure: `WorkbookRuntime::validate_formula(sheet, row, col, text) -> Result<Value, RuntimeError>` runs the full lex/parse/bind/eval pipeline without mutating workbook, op log, or plan cache. IDE can call per-keystroke. |
| GAP-I-05 | No cancellation API on long-running engine operations (`recompute_all`, `transaction::commit`, future `replay_into`). For 1k-formula workbooks instant; for 100k+ blocks the binding thread. | `ql-exec/src/workbook_runtime.rs::recompute_all` (no `CancelToken` parameter) | Engine | Engine Phase 6.1 (Session API + cancellation) |

### Documentation

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-D-01 | Phase 2 docs had STALE wording about 2A.3 being deferred — banner-patched but not rewritten | `docs/phase2/{entry-plan,exit-packet}.md` banners | Engine | Closed as banner; full rewrite if needed in Engine Phase 2B exit |
| GAP-D-02 | Phase 3 / 4 / 5 / 6 / 7 `entry-plan.md` and `exit-packet.md` don't exist yet | Files absent under `docs/phase{3,4,5,6,7}/` | Engine | Created per phase as work begins |
| ~~GAP-D-03~~ | ~~No `docs/architecture/` directory~~ — **CLOSED** in Engine Phase 3.1+3.10. `docs/architecture/calcgraph-runtime.md` exists; parser-and-semantics and collaboration-crdt docs deferred to Phase 5 entry (their phases haven't started). |
| ~~GAP-D-04~~ | ~~Excel compatibility matrix (`docs/compat/excel-matrix.md`) doesn't exist~~ — **CLOSED** in Engine Phase 4.2 (W5-45). 217-row matrix + `scripts/report-compat-coverage.sh` CI reporter. |
| GAP-D-05 | Legal / provenance notes for adopted reference patterns not collected | `docs/legal/` absent | Engine | Engine Phase 7 ship prep |

## Closed gaps

- **GAP-R-02** (recompute_all short-circuit) — closed in Engine Phase 2B.2.
- **GAP-R-03** (bind-plan re-derivation) — closed in Engine Phase 2B.3.
- **GAP-O-01 / GAP-O-02 / GAP-O-03** (op-log producer bypasses for set_name / add_sheet / put_at + clear_formula) — closed in Engine Phase 2B.5.
- **GAP-I-02** (engine-side IDE-consumption test harness) — closed in Engine Phase 2B.6.
- **GAP-I-04** (no dry-run formula validation API) — closed in Engine Phase 2B.7 audit closure: `WorkbookRuntime::validate_formula`.
- **GAP-S-01** (single overlay per chunk, user + formula outputs conflated) — closed in Engine Phase 3.5: parallel `user_overlays` + `computed_overlays` with read cascade user → computed → base.
- **GAP-B-01** (named-range aggregate eval returned `#CALC!`) — fully closed in Engine Phase 3.6 (W5-39): the scalar evaluator now computes the real aggregate for SUM/AVERAGE/MIN/MAX/COUNT/PRODUCT over a single named-range arg + caches the result on `CalcgraphSession`.
- **GAP-R-04** (volatile function invalidation) — closed in Engine Phase 3.7 (W5-40): `mark_volatile_dirty` fans out volatile cells + downstream chain; NOW/TODAY/RAND/RANDBETWEEN registered; deterministic test RNG via `set_test_rng_seed`.
- **GAP-R-05** (value-equality short-circuit) — closed in Engine Phase 3.8 (W5-41): `recompute_dirty` skips formulas whose direct cell deps stayed at their prior values. `RecomputeResult.skipped_value_equality` exposes the count.
- **GAP-D-03** (no `docs/architecture/` directory) — closed in Engine Phase 3.1 + 3.10 (W5-34, W5-43): `docs/architecture/calcgraph-runtime.md` exists with full Phase 3.x rewrite.
- **GAP-D-04** (Excel compatibility matrix file absent) — closed in Engine Phase 4.2 (W5-45): `docs/compat/excel-matrix.md` ships with 217 rows + `scripts/report-compat-coverage.sh` CI reporter.
- **Phase 3 megaudit H2** (`on_set_name` not transitive) — closed in 3.10 audit-closure commit (W5-43): BFS-fanout fix + regression test `h2_set_name_propagates_dirty_transitively`.
- **Phase 2B.7 audit-closure fixes** (correctness): orphan op-log entries on `add_sheet`(chunk_rows=0 / SheetId::MAX), `set_name` mutate-first divergence, `set_value` / `clear_formula` partial-pair non-atomicity, `transaction::commit` post-mutation log append. All fixed. `Workbook` and `OpLog` proven `Send + Sync` at compile time. See `docs/audits/2026-05-12-phase-2B.md`.
- **GAP-G-01** (rebind staleness — Phase 3.10 megaudit H3/H4) — closed in Engine Phase 4 pre-V2: rebind path in W5-50 (`extract_and_register_deps`), clear-formula path in W5-52 (`on_clear_formula`; W5-52 audit closure caught the clear-path miss). `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula` + `StripeIndex::clear_for_formula` (with reverse `formula_to_stripe_keys`). Architectural decision: `docs/architecture/2026-05-13-graph-storage-decision.md`.
- **GAP-G-03** (range deps not scheduler edges — Phase 3.10 megaudit H1) — closed in Engine Phase 4 pre-V2 (W5-50): `topo::schedule_with_supplemental` accepts caller-injected temp adjacency; `CalcgraphSession::build_range_supplemental` constructs F→G edges for dirty formula pairs where G is inside one of F's ranges. Architectural decision: `docs/architecture/2026-05-13-graph-storage-decision.md`.

---

## How to use this doc

- **Adding a gap:** new row in the relevant section. Always include reproduce path + target Engine phase.
- **Closing a gap:** move the row to `Closed gaps` with closing commit SHA + date.
- **At every phase exit:** sweep this list, move closed items, add any new ones surfaced during the phase.
- **No gap stays untargeted.** If a gap can't fit any planned phase, that's a planning problem — escalate to MASTER-PLAN.md edit.
