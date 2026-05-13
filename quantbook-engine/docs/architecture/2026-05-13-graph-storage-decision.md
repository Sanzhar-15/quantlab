# Graph storage architecture decision — GAP-G-01 + GAP-G-03

**Status:** **DECISION MADE W5-49 → IMPLEMENTED W5-50 → AUDIT-CLOSED W5-52 → GAP-F-05 (function-dispatch signature) CLOSED W5-53.** Both GAP-G-01 (rebind staleness, including the W5-52 clear-formula path follow-up) and GAP-G-03 (range deps not scheduler edges) shipped. Earlier draft of this doc said "NOT shipped"; that wording was current 2026-05-13 morning and has been amended by the W5-52 closure section below. See `docs/audits/2026-05-13-engine-session-final-handoff.md` for the integrated session view.
**Author:** Claude Opus 4.7 (W5-49) + Codex (gpt-5.5, independent read-only review).
**Affects:** `crates/ql-calcgraph/` (Graph, StripeIndex, AdjacencyVectors, Tarjan scheduler) + `crates/ql-exec/src/calcgraph_session.rs` (extract_and_register_deps wiring).
**Blocks:** Phase 4.3 V2 (SUMIF / COUNTIF / SUMIFS / AVERAGEIF / VLOOKUP / HLOOKUP / INDEX / MATCH / CHOOSE — the range-aware function batch).
**Precondition for:** Phase 4.3 V2 batch, Phase 4.7 array formulas (FormulaRegion binder rests on Option A's revocation API).
**Companion docs:**
- `docs/audits/2026-05-12-phase-3-megaudit.md` — origin of the issue (Phase 3.10 megaudit findings H1, H3, H4).
- `docs/audits/2026-05-13-session-handoff.md` — the W5-47 framing with three options.
- `docs/audits/2026-05-13-deep-audit-closure.md` — W5-48 honesty patches that left the architectural decision pending.
- `docs/audits/2026-05-13-codex-graph-decision-review.txt` — the full Codex review that informed this doc.
- `docs/architecture/calcgraph-runtime.md` — current calcgraph integration surface; will be updated after implementation closes G-01 + G-03.

## Decision

**Option A + a tightly-scoped Option C. Defer Option B (FormulaRegion binder) to Phase 4.7.**

GAP-G-01 (rebind staleness) and GAP-G-03 (range deps not scheduler edges) are independent correctness failures with independent fixes. They ship as one architectural change because they share the gate that blocks Phase 4.3 V2. Implementation order is **A before C** — Option C reads `formula_to_range_deps`, which Option A makes current.

- **Option A** — Add per-formula revocation API to `Graph` + `StripeIndex`. Reverse-index stripe membership so per-formula clear is `O(stripes-this-formula-is-in)` rather than scanning the whole stripe map. Call the new APIs in `extract_and_register_deps` at the same point as the existing `remove_formula_deps`. Keeps `Vec<Vec<NodeId>>` adjacency, no new graph library, no `IndexSet`/`petgraph` dep, no edge-epoch metadata.
- **Option C (small variant)** — At recompute time, before invoking Tarjan, build a temporary supplemental adjacency: for each dirty formula `F` with range deps, for each dirty FORMULA node `G` (including `G == F` for self-range cycles like `A1 = SUM(A1:A1)`), if `G`'s cell address is contained in one of `F`'s ranges, push `G` into `supplemental[F]`. Pass the map to a new `topo::schedule_with_supplemental` variant. Discard the map after the scheduler returns. (W5-52 audit-closure clarification: earlier wording said "OTHER" dirty formula nodes; the implementation intentionally allows the self-edge case.)
- **Option B (FormulaRegion binder + region detection)** is the right design for Phase 4.7 array formulas + Phase 4.7 SIMD region dispatch (GAP-G-02), but the wrong tool for Phase 4.3 V2: region-detection-at-write is its own correctness surface, and SUMIF/COUNTIF/lookup functions don't need region semantics — just correctly-ordered range-aware recompute. Folding G-01/G-03 fixes into B couples them to a much larger Phase 4.7 redesign that doesn't need to ship first.

## The two bugs (problem statement)

### GAP-G-01 — rebind staleness (megaudit H3 + H4; correctness)

`Graph` (`crates/ql-calcgraph/src/graph.rs`) uses append-only `AdjacencyVectors` (`crates/ql-calcgraph/src/edges.rs:32` — `Vec<Vec<NodeId>>` outgoing + incoming). `Graph::add_edge` (graph.rs:163) and `Graph::register_range_dependency` (graph.rs:180-211) only append. The session-side `remove_formula_deps` (`calcgraph_session.rs:525-545`) cleans the four session-side reverse indices (`formula_deps`, `name_to_formulas`, `cell_to_formulas`, `volatile_formulas`) but explicit comment at line 522-524:

> Does NOT touch the Phase 0 `Graph`'s stripe state or edges (append-only contract).

Concrete failure (megaudit H3):

```
1. set_formula(B1, "=A1")  → outgoing[B1] = [A1]
2. set_formula(B1, "=1")   → outgoing[B1] still [A1] (stale)
3. set_formula(A1, "=B1")  → outgoing[A1] = [B1] (new), outgoing[B1] still [A1] (stale)
4. recompute_dirty         → Tarjan sees A1 → B1 → A1 → cycle → both emit #CIRC!
```

The cycle is FALSE: B1 no longer depends on A1, A1 depends on B1, the system should compute A1 = current(B1) = 1.

Megaudit H4 is the range-side variant:

```
1. set_formula(B1, "=SUM(A:A)")   → Column-A stripe ∋ B1, formula_to_range_deps[B1] = [A:A]
2. set_formula(B1, "=SUM(B:B)")   → Column-B stripe ∋ B1 (new), Column-A stripe still ∋ B1 (stale), formula_to_range_deps[B1] = [A:A, B:B] (stale carries over)
3. set_value(A5, 42)              → dependents_for_cell(A, 5) finds B1 via stale Column-A stripe; precision check passes against stale A:A → B1 falsely dirty
4. recompute_dirty                → B1 recomputes even though it no longer reads Column A
```

The cost is mostly false-positive dirty work plus the megaudit H3-style false-cycle interaction.

### GAP-G-03 — range deps not scheduler edges (megaudit H1; correctness)

`register_range_dependency` populates `StripeIndex` + `formula_to_range_deps` but never calls `add_edge`. Tarjan in `crates/ql-calcgraph/src/topo.rs:151` walks `graph.outgoing(v)` only. So:

```
A1 = "=SUM(B1:B1)"   → register_range_dependency(A1, B1:B1, sheet)
B1 = "=A1+1"         → add_edge(B1, A1)
```

The graph holds `outgoing[B1] = [A1]` (real edge) but `outgoing[A1] = []` (no edge to B1; range dep is in the stripe index, not the edge list). Tarjan's input graph cannot see the cycle. Megaudit H1 also calls out the non-cycle ordering bug:

```
A1 = "=SUM(B1:B1)"   (depends on B1 via range)
B1 = "=A2 + 1"       (depends on A2 directly)
edit A2              → both A1 and B1 fan out dirty (B1 via cell_to_formulas, A1 via Column-B stripe)
recompute_dirty      → Tarjan sees only B1 → A2 explicit edge; A1's range dep on B1 invisible
                     → A1 may evaluate before B1, reading stale B1
```

## Options considered

| Option | What | Closes | Cost | Verdict |
|---|---|---|---|---|
| **A** — Delta-edge graph storage | `Graph::clear_outgoing(node)` + `Graph::clear_range_deps_for_formula(node)` + `StripeIndex::clear_for_formula(node)` backed by reverse index `formula_to_stripe_keys`. Wire into `extract_and_register_deps`. | GAP-G-01 directly. | ~1 strong session per Codex (W5-47 over-estimated as 3-5 days). | **SHIP**. |
| **C** (small) — Tarjan supplemental adjacency | At recompute, build `supplemental: HashMap<NodeId, Vec<NodeId>>` of temp F→G edges (G dirty formula in F's range). Pass to `schedule_with_supplemental`. Discard after. | GAP-G-03 directly. | ~0.5-1 session. | **SHIP after A**. |
| **B** — FormulaRegion binder + region detection at write-time | New graph vertex shape; range deps become FormulaRegion edges natively. SIMD dispatch flows from same node. | Most of G-01 + G-03 + GAP-G-02 (perf). | 1-2 weeks; region detection at write is its own correctness surface. | **DEFER to Phase 4.7** (array formulas). |
| D (epoch-marked edges) | Tag edges with formula epoch; filter at scheduler time. | G-01. | Permanent memory overhead + filter cost on every traversal. | Rejected by Codex. |
| D (IndexSet adjacency) | Switch outgoing/incoming to `Vec<IndexSet<NodeId>>`. | Removes the "linear scan to remove back-pointer" concern. | Adds a workspace dep + changes memory profile. | Marginal; not worth the dep. |
| D (rebuild from plans every recompute) | Re-extract dep graph from session-held plans each recompute. | G-01 + G-03. | Pays bind/extract on the recompute hot path. | Rejected — defeats incremental. |

## Implementation outline (next session(s))

Sequenced strictly A before C. Each phase is its own commit. Land both phases before starting Phase 4.3 V2.

### Phase A.1 — `StripeIndex` reverse lookup

File: `crates/ql-calcgraph/src/stripes.rs`

- Add field `formula_to_stripe_keys: HashMap<NodeId, Vec<StripeKey>>`.
- Update the existing `insert(key, formula_node)` (stripes.rs:194) — when the per-stripe `HashSet::insert(formula_node)` returns `true` (newly inserted), also append `key` to `formula_to_stripe_keys[formula_node]`. Preserves the existing dedup semantics: re-registering a `(formula, range)` doesn't bump `stripe_inserts` and doesn't double-add to the reverse vector.
- Add `clear_for_formula(formula_node)` — iterates the reverse vector, removes `formula_node` from each stripe's set (with empty-bucket pruning matching the existing inverse pattern), drops the reverse-vector entry.
- Tests: clear removes the formula from all stripes; subsequent re-register works post-clear; `stripe_count` + `total_insertions` stay consistent; idempotent (clear twice is no-op).

### Phase A.2 — `Graph` revocation API

Files: `crates/ql-calcgraph/src/graph.rs` + `crates/ql-calcgraph/src/edges.rs`

- `AdjacencyVectors::clear_outgoing(from) -> Vec<NodeId>` (new): `std::mem::take(&mut self.outgoing[from.index()])` and return the drained list to the caller.
- `Graph::clear_outgoing(node)`: calls the above, then for each former target `t` does `self.edges.incoming[t.index()].retain(|&n| n != node)`. Bumps `revision` once.
- `Graph::clear_range_deps_for_formula(node)`: removes `node` from `formula_to_range_deps`, calls `self.stripes.clear_for_formula(node)`. Bumps `revision` once.
- Tests: symmetric invariant preserved (`outgoing[u] ∋ v ⟺ incoming[v] ∋ u`); revision bumps correctly; idempotent; clear preserves OTHER formulas' edges.

### Phase A.3 — Wire into the session rebind path

File: `crates/ql-exec/src/calcgraph_session.rs` at line 440 (`extract_and_register_deps`).

After the existing `self.remove_formula_deps(formula_node)` call (line 449), insert:

```rust
self.graph.clear_outgoing(formula_node);
self.graph.clear_range_deps_for_formula(formula_node);
```

Update the docstring at lines 426-431 — remove the "Stripe-side stale entries DO accumulate on re-bind" passage and replace with a note that graph + stripe state is wholesale revoked before re-registration.

### Phase A.4 — Regression tests (closes GAP-G-01)

In `crates/ql-exec/src/calcgraph_session.rs::tests` and/or `crates/ql-exec/src/workbook_runtime.rs::tests`:

- **H3 example test:** set B1 = "=A1"; assert `outgoing[B1] = [A1]`. Rebind B1 = "=1" (constant); assert `outgoing[B1] = []` AND `incoming[A1]` no longer contains B1. Then set A1 = "=B1"; assert `recompute_dirty()` produces no `#CIRC!`, B1 = 1, A1 = 1.
- **H4 example test:** set B1 = "=SUM(A:A)"; assert Column-A stripe contains B1. Rebind B1 = "=SUM(B:B)"; assert Column-A stripe NO LONGER contains B1, Column-B stripe DOES, `formula_to_range_deps[B1]` contains only B:B. Then `set_value(A, 5, 42)`; assert B1 NOT in `dirty_formulas()`.
- **Determinism test:** rebind `=A1+B1+C1` to `=A1+B1+C1` (same plan). Assert `outgoing[F]` is byte-for-byte identical pre/post.
- **Self-clear no-op:** call `clear_outgoing` on a node with no outgoing edges; assert no panic, no state change.

### Phase C.1 — Tarjan supplemental adjacency

File: `crates/ql-calcgraph/src/topo.rs`

- Add `pub fn schedule_with_supplemental(graph, dirty_subset, supplemental: &HashMap<NodeId, Vec<NodeId>>) -> Schedule`. In `tarjan_dfs`'s child-enumeration loop, after consuming `graph.outgoing(v)`, also iterate `supplemental.get(&v).map(|v| v.as_slice()).unwrap_or(&[])`. The dirty-filter at the existing line `if dirty.contains(&candidate)` keeps the supplemental edges in scope only for dirty nodes.
- Keep `pub fn schedule(graph, dirty_subset) -> Schedule` as a thin wrapper that passes an empty `HashMap`.
- Tests: empty supplemental yields identical Schedule to the current `schedule`; supplemental cycle (A→B in supplemental, B→A in real graph) gets cycled; non-supplemental cycles still detected; supplemental edge to a non-dirty node is correctly ignored.

### Phase C.2 — Wire into recompute

Files: `crates/ql-exec/src/calcgraph_session.rs` (`schedule_dirty`) + `crates/ql-exec/src/workbook_runtime.rs` (`recompute_dirty` at line 886).

- New helper `CalcgraphSession::build_range_supplemental(&self, dirty: &HashSet<NodeId>) -> HashMap<NodeId, Vec<NodeId>>`:
  - For each dirty formula node `F`, look up `formula_to_range_deps[F]`.
  - For each range `R` in F's range list, for each dirty formula node `G` in `dirty` (including `G == F` for self-range cycles), if `G`'s cell address (via `cell_address_for(G)`) satisfies `stripes::range_contains_rowcol(R, row, col)` AND `G.sheet == range.sheet` (resolved), push `G` into `supplemental[F]`. (W5-52 audit closure also added dedup so the same G doesn't appear twice when F has overlapping ranges.)
  - Optimization knob: if profiling shows the O(|dirty_formulas|²) inner loop is hot, switch to per-range bucketing. Not premature for V1.
- `schedule_dirty` calls the new variant with the supplemental.
- Update `recompute_dirty` call path to thread the supplemental through.

### Phase C.3 — Regression tests (closes GAP-G-03)

- **H1 example #1 — range-induced cycle:** A1 = "=SUM(B1:B1)", B1 = "=A1+1". Both dirty (write A1 fresh, then write B1). Assert Tarjan emits both in `cycled`; both evaluate to `#CIRC!`.
- **H1 example #2 — range-induced ordering:** A1 = "=SUM(B1:B1)", B1 = "=C1+1", C1 = 10. Write C1 → fanout dirties both A1 and B1. Assert Tarjan emits `[B1, A1]` order (B1 first because A1's range covers it). Assert B1 = 12, A1 = 12.
- **Self-range cycle:** A1 = "=SUM(A1:A1)". Dirty A1. Assert Tarjan emits A1 in `cycled`.
- **Partial dirty (Codex caveat):** A1 = "=SUM(B1:B1)" where B1 is a LITERAL (B1 = 5, no formula). Write A1 → only A1 dirty. Assert supplemental map is empty (B1 not a formula node). Assert A1 = 5 (evaluates against current B1).
- **Determinism:** same workbook, same dirty set, two recomputes → identical Schedule.

### Phase A+C acceptance

- Workspace `cargo test --workspace` count grows from 981 by at least ~25 (regression tests above).
- All 7 existing gates green: fmt, clippy `-D warnings`, build-flags, cargo-lock pin, multiversion clones, cargo audit, workspace tests.
- `scripts/report-compat-coverage.sh` unchanged at 40% (no function-library changes).
- `docs/architecture/calcgraph-runtime.md` updated: remove the "Stale stripes on re-bind (GAP-G-01)" section + the GAP-G-03 / GAP-G-01 mentions; reflect the new revocation contract.
- `docs/known-gaps.md` moves GAP-G-01 and GAP-G-03 to the "Closed gaps" section with closing commit SHAs.
- `docs/MASTER-PLAN.md` Phase 4 entry updated: prerequisite line removed (or marked shipped).
- Phase 4.3 V2 (SUMIF/COUNTIF/lookup family) is now safe to start.

## Codex review summary

Codex (gpt-5.5, read-only sandbox, ~10 min wall, 6083-line output) was dispatched W5-49 with a self-contained briefing including the three options + my preliminary view. The full review is at `docs/audits/2026-05-13-codex-graph-decision-review.txt`. Key findings that shaped this decision:

1. **Independence confirmed.** G-01 = stale stored graph/range state after rebind; G-03 = missing scheduler visibility for live range deps. Neither fix subsumes the other. Codex: "Fixing A does not make range deps scheduler edges; fixing C does not revoke stale direct edges or stale stripe/range registrations."
2. **Positive interaction → A before C is mandatory.** Codex: "Option C must read the current `formula_to_range_deps`; Option A makes that map current by clearing stale entries before re-registering. Without A, C can amplify G-01 by scheduling against stale range deps."
3. **Option C scope tightening (refinement Codex contributed):** temp edges only between **dirty formula nodes**, NOT arbitrary dirty cells. This matches the existing Tarjan contract at `topo.rs:40` ("Edges to nodes outside `dirty_subset` are not traversed") and avoids materializing edges to non-schedulable cells.
4. **Option A shape confirmed.** Back-pointer removal from `incoming[target]` is required for the symmetric invariant; linear scan is acceptable because rebind happens at edit-rate, not recompute-rate. The `formula_to_stripe_keys` reverse index is essential — without it, per-formula stripe clear would be O(total_stripes) and a real scale risk. Bump `revision` once per clear, not per edge.
5. **Option D variants rejected.** Epoch-marked edges keep stale memory + push correctness filtering into every scheduler traversal. `IndexSet` adds a dep and changes memory profile. Full rebuild from plans pays bind/extract on the hot path. Codex: "Best 'D' is a bounded variant of A+C."
6. **Effort estimate revised DOWN.** W5-47 said 3-5 days for A. Codex: "The core A change is smaller because the session already has the rebind choke point... Option A: 1 strong session, maybe 2 if graph stats/revision expectations need cleanup. Option C: 0.5-1 session."

## W5-52 audit closure amendments (2026-05-13, post-ship)

After W5-50 + W5-51 shipped, a deep mega-audit ran with both Codex and a Sonnet agent in parallel. They independently flagged one HIGH issue and several MEDIUM/LOW. Documented here for honesty:

### HIGH (fixed in W5-52)

- **`on_clear_formula` was not revoking graph state.** The original W5-50 implementation wired `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula` into `extract_and_register_deps` (the rebind path) but missed `on_clear_formula` (the clear path). Result: clearing a formula left stale forward edges + stripe registrations — the same H3/H4 staleness class W5-50 was built to fix. Reproducible as `A1 = SUM(A1:A1)` → clear A1 → on_set_value(A1) re-fans-out via stale stripe → false `#CIRC!` cycled. Fixed in W5-52 by adding the same two revocation calls inside `on_clear_formula`'s `if let Some(node)` block. Three new regression tests (`clear_formula_revokes_outgoing_graph_edges`, `clear_formula_revokes_range_stripes`, `clear_formula_then_no_phantom_cycle`).

### MEDIUM — scope gap that ALSO blocked Phase 4.3 V2 (CLOSED W5-53)

- **`ScalarFn = fn(&[Value]) -> Value` signature cannot carry range-vs-scalar metadata.** This doc claimed Phase 4.3 V2 (SUMIF / COUNTIF / VLOOKUP) "is now unblocked" once A+C ship. That's true for the GRAPH substrate, but a second blocker — the function-dispatch signature — was not surfaced in the W5-49 decision and was discovered during W5-51 (trig batch). **CLOSED W5-53:** filed as GAP-F-05; closed in the same audit-closure arc via a parallel `RangeAwareFn = fn(&[FnArg]) -> Value` table with `enum FnArg { Scalar(Value), Range(Vec<Value>) }`. The existing 59 scalar entries stay under the `ScalarFn` contract; new range-aware functions live in the second table. SUMIF + COUNTIF shipped W5-53 as the first range-aware functions; the SUMIFS / AVERAGEIF / lookup family is now unblocked.

### MEDIUM — supplemental dedup (cleanliness, not correctness)

- **`build_range_supplemental` could push duplicate G entries** when F had overlapping ranges (e.g., `SUM(A1:A10) + SUM(A1:A5)` both contain G at A3). Tarjan handles duplicate edges correctly, so this was a perf/cleanliness issue, not a correctness bug. W5-52 adds a per-F `HashSet<NodeId>` dedup in the inner loop.

### LOW (fixed in W5-52)

- ATAN2 rustdoc title said `(y, x)`; body and tests correctly used Excel's `(x_num, y_num)`. Doc-only inversion.
- Two places in this doc said "OTHER dirty formula nodes"; the implementation intentionally includes the self-edge for self-range cycles. Wording corrected above.

### LOW (acknowledged, not fixed)

- `Graph::clear_outgoing` / `clear_range_deps_for_formula` bump the revision counter even when called on a node with no edges / no range deps. State-idempotent, revision-not-idempotent. Affects only callers that use revision as a cheapness proxy — none today.
- W5-50 commit message per-file test count breakdown is off by ±1 in two files (cancels in total +35).

## Stop conditions

Revisit this decision if any of the following surface during or after implementation:

- **Phase 4.3 V2 actually requires FormulaRegion for function SEMANTICS (not just perf).** None of SUMIF / COUNTIF / VLOOKUP / INDEX / MATCH / CHOOSE need region semantics — they're scalar functions over ranges. If a function in scope unexpectedly needs region-aligned eval (unlikely), pause and reconsider Option B.
- **`formula_to_stripe_keys` memory unacceptable at scale.** Worst case: each formula carries one `StripeKey` (16 bytes) per stripe it depends on. For 1M formulas each depending on 1 range = 16MB overhead. Acceptable. For 1M formulas with avg 4 ranges = 64MB. Still acceptable. Revisit only if benchmarks show it's the bottleneck.
- **Clearing back-pointers shows measurable edit-latency regression on high-fan-in sheets.** Worst case: rebind a formula whose old deps include a cell with N dependents; the `retain` scan is O(N) per former target. Typical worksheets have low fan-in; mitigate if observed by switching the affected targets' `incoming` to an `IndexSet` lazily.
- **Option C cannot be made deterministic.** The supplemental-edge build order must be deterministic; iterating `dirty: HashSet<NodeId>` gives random order. Sort by `NodeId` before iterating, the same way `Graph::dependents_for_cell` does (graph.rs:251).

## Implementation watch list

From Codex's review, the regression suites should explicitly cover:

- Stale direct-edge false cycles (H3 scenario).
- Stale range dirtying after rebind (H4 scenario).
- Range-induced cycles (H1 scenario #1).
- Range-induced ordering (H1 scenario #2).
- Self-range cycles (`A1 = SUM(A1:A1)`).
- VEQ behavior for range-dep formulas (Phase 3.8 short-circuit + supplemental edges must compose).
- "Same rebind same schedule order" determinism (covered in Phase A.4 + C.3).

## References (code paths touched)

- `crates/ql-calcgraph/src/graph.rs` — Graph (append-only adjacency + range-dep maps).
- `crates/ql-calcgraph/src/edges.rs` — AdjacencyVectors (Vec<Vec<NodeId>>).
- `crates/ql-calcgraph/src/stripes.rs` — StripeIndex (HashMap<StripeKey, HashSet<NodeId>>) + `range_contains_rowcol`.
- `crates/ql-calcgraph/src/topo.rs` — Tarjan SCC scheduler.
- `crates/ql-exec/src/calcgraph_session.rs` — `extract_and_register_deps`, `remove_formula_deps`, `schedule_dirty`, `mark_dirty_from_cell_write`.
- `crates/ql-exec/src/workbook_runtime.rs` — `recompute_dirty`.

## Provenance

This decision was reached in session 2026-05-13 (W5-49). The preliminary view was drafted before Codex was dispatched; Codex's independent review confirmed the split framing and refined the Option C scope. No view was attributed to Codex without surfacing it from Codex's actual output. The Codex review file lives alongside this doc.
