# Architectural decision review — Quantbook engine GAP-G-01 + GAP-G-03

You are auditing an architectural decision for the Quantbook spreadsheet engine. The engine is at `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/`. Branch `feat/quantbook-engine`, HEAD `e52376f46b4` (W5-48). 981 workspace tests, all gates green.

Phase 3 (calcgraph runtime integration) shipped 10 sub-items. The Phase 3.10 megaudit (which YOU ran on 2026-05-12 — `docs/audits/2026-05-12-phase-3-megaudit.md`) flagged H1, H3, H4 as correctness-relevant carryovers gated on a graph-storage architectural decision. They are now filed as:

- **GAP-G-01** (rebind staleness, correctness): The Phase 0 `Graph` (`crates/ql-calcgraph/src/graph.rs`) uses append-only `Vec<Vec<NodeId>>` for both outgoing and incoming adjacency. `register_range_dependency` (`graph.rs:180-211`) appends to `formula_to_range_deps` and the stripe index — never revokes. When a formula's text changes (`B1 = A1` → `B1 = 1` → user later writes `A1 = B1`), the stale `B1 → A1` outgoing edge plus the new `A1 → B1` edge make Tarjan emit a FALSE `#CIRC!` for both. Megaudit H3.

- **GAP-G-03** (range deps not scheduler edges, correctness): `register_range_dependency` populates the stripe index + the precision-check map but does NOT call `Graph::add_edge`. The Tarjan scheduler (`crates/ql-calcgraph/src/topo.rs`) walks `graph.outgoing(v)` only. So `A1 = SUM(B1:B1)` + `B1 = A1+1`: the cycle is invisible to Tarjan; A1 may evaluate first using a stale B1 (or vice versa). Megaudit H1.

Read this verbatim (use Read tool, don't paraphrase):
- `quantbook-engine/docs/audits/2026-05-13-session-handoff.md` (W5-47)
- `quantbook-engine/docs/audits/2026-05-13-deep-audit-closure.md` (W5-48; your own findings)
- `quantbook-engine/docs/audits/2026-05-12-phase-3-megaudit.md` (W5-43; your prior audit)
- `quantbook-engine/docs/architecture/calcgraph-runtime.md`
- `quantbook-engine/crates/ql-calcgraph/src/graph.rs` (~647 lines)
- `quantbook-engine/crates/ql-calcgraph/src/edges.rs` (~190 lines)
- `quantbook-engine/crates/ql-calcgraph/src/stripes.rs` (~560 lines)
- `quantbook-engine/crates/ql-calcgraph/src/topo.rs` (~462 lines)
- `quantbook-engine/crates/ql-exec/src/calcgraph_session.rs` (lines 269-720 most relevant — `extract_and_register_deps`, `remove_formula_deps`, `on_set_formula`, `on_clear_formula`, `mark_dirty_from_cell_write`)

## The three options the W5-47 handoff laid out

**Option A — Delta-edge graph storage.** Add `Graph::clear_outgoing(node)` + `Graph::clear_range_deps_for_formula(node)` + `StripeIndex::clear_for_formula(node)`. Add reverse lookup `formula_to_stripe_keys: HashMap<NodeId, Vec<StripeKey>>` so the stripe clear is O(stripes-this-formula-is-in) not O(total-stripes). At extract_and_register_deps entry, call those clears before the new register pass. Estimated 3-5 days. Closes GAP-G-01 directly.

**Option B — FormulaRegion binder + region detection.** At write-time, detect whether a formula matches a column-aligned region pattern and emit a `FormulaRegion` graph vertex that owns the range edge. Aligns with the Phase 4.7 array-formulas roadmap and with GAP-G-02 (SIMD region dispatch). Estimated 1-2 weeks. Closes G-02 + G-03 + most of G-01.

**Option C — Lazy range expansion at recompute.** Keep Phase 0 graph contract. In `recompute_dirty`, before Tarjan, for each dirty formula F with range deps, walk dirty cells and inject temporary `F → cell` edges into the Tarjan input. Discard after. Estimated 2-3 days. Closes G-03 only; doesn't help G-01.

W5-47 author recommendation: **Option A first** (correctness fix for G-01), then B or C for G-03 depending on Phase 4.7 bandwidth.

## My (Claude's) preliminary view — for you to challenge

The two bugs are **independent failure modes with independent fixes**, and conflating them into "pick one of A/B/C" is the wrong framing:

- **GAP-G-01 fix → Option A only.** Add per-formula revocation API to Graph + StripeIndex; call it at extract_and_register_deps entry. The current `remove_formula_deps` at `calcgraph_session.rs:525` already cleans session-side reverse indices but explicitly does NOT touch graph edges / stripes ("Does NOT touch the Phase 0 `Graph`'s stripe state or edges (append-only contract)"). Extend it.

- **GAP-G-03 fix → small Option C.** Add a Tarjan-input augmentation pass: for each dirty formula `F` with `formula_to_range_deps[F]`, for each dirty cell `c`, if `range_contains_rowcol(range, c)` then push a temp edge `F → c_node`. This lives inside `recompute_dirty` or as a new `topo::schedule_with_range_deps` variant. No graph storage change.

- **Option B is the wrong tool for now.** FormulaRegion-as-binder is the Phase 4.7 design for array formulas + SIMD region dispatch (GAP-G-02). Region detection at write time is its own correctness surface (when does a new column-aligned formula belong to an existing region vs spawn a new one? what about non-uniform formulas that LOOK like a region but aren't?). Folding G-01/G-03 fixes into B couples them to a much bigger Phase 4.7 redesign that doesn't need to ship first.

- **Combined A + C is the minimum surgical correctness fix.** Estimated 1 session for A (mostly mechanical: APIs + reverse lookup + wire into extract_and_register_deps + regression tests for the H3/H4 examples), 0.5-1 session for C (single Tarjan-input augmentation pass + regression tests for the H1 examples). Total ~1-1.5 sessions of implementation.

- **Phase 4.3 V2 unblocks after both ship.** SUMIF/COUNTIF/lookup family all exercise range-as-edge correctness (GAP-G-03), so without C they'd ship onto a broken substrate. SUMIF over a rebound range would also exercise GAP-G-01.

## What I want from you

Independently — without anchoring to my view — answer:

1. **Are G-01 and G-03 actually independent?** Or does one of the fixes accidentally regress the other? E.g., does Option C's temp-edge augmentation interact with Option A's removed stale stripes in some subtle way?

2. **Is Option C correct?** Specifically: at recompute_dirty time, when we walk `formula_to_range_deps[F]` and inject temp edges to dirty cells in the range — are there cases where this produces a wrong cycle classification (e.g., a phantom cycle that wouldn't exist with proper edges)? The example A1 = SUM(B1:B1), B1 = A1+1: dirty set = {A1, B1}. Walk A1's range deps → B1 in range, B1 in dirty → temp edge A1→B1. Walk B1's deps → cell ref to A1 → real edge B1→A1. Tarjan sees A1→B1, B1→A1 → SCC of size 2 → cycled. Looks correct. But what about partial dirty sets? If only A1 is dirty and we're recomputing it because of a name change, B1 isn't dirty — the temp-edge pass adds nothing, Tarjan emits A1 alone, A1 evaluates against the CURRENT B1 value. Is that wrong? Excel canon: a name change should mark every dependent dirty. Phase 3.10 H2 fix made on_set_name BFS-fanout — so B1 would be dirty too via that fix. Reassure or refute this reasoning.

3. **Is the Option A revocation API the smallest correct change to `Graph`?** Concretely: should `Graph::clear_outgoing(node)` also walk each former target's `incoming[target]` to remove the back-pointer? (Yes, for symmetry — but is the linear scan acceptable? Most cell formulas have ≤4 outgoing edges so the per-rebind cost is `Σ over edges of O(in_degree(target))`. For a heavy DAG with high in-degree nodes that could be costly — but how often does rebind hit such nodes?) What about determinism — `Vec` preserves insertion order, but after `clear_outgoing + re-extract` the new edges may be in a different order if the binder pass yields a different walk order; is that observable downstream? (My read: Tarjan's output ordering depends on insertion order via dfs_stack scan order — so yes, observable. But re-extract from the SAME plan should produce the SAME walk order, so as long as Plan→deps extraction is deterministic, the new edge order matches the old.)

4. **Is there a simpler / better Option D I haven't considered?** For example:
   - Mark edges with a per-formula epoch counter; sweep stale-epoch edges at scheduler time. Avoids removal API but adds epoch metadata to every edge.
   - Switch `outgoing` to `Vec<IndexSet<NodeId>>` (preserves order AND allows O(1) remove). Adds a dep but simpler removal contract.
   - Compute the scheduler-relevant edge set from scratch at every recompute_dirty by re-reading bound plans from the session — avoids stale-edge problem entirely but pays per-recompute extraction cost.

5. **The W5-47 author claims Option A is a "3-5 day refactor" and re-test of Phase 3.1-3.8.** Is that accurate? Or is it actually smaller (the existing extract path already calls `remove_formula_deps`; we just expand its scope) — or larger (some test or invariant deeper in Phase 3 silently depends on the append-only contract)?

6. **Stop conditions: what would invalidate the "ship A + C now, defer B to Phase 4.7" decision?**
   - If Phase 4.3 V2 SUMIF/COUNTIF/lookup ALSO needs the FormulaRegion binder for non-correctness reasons.
   - If Option A causes a subtle perf regression on the OG-02 25M-cell hot path.
   - If the reverse `formula_to_stripe_keys` index materially inflates memory at scale.

Be specific. Read the actual code. If you disagree, say so plainly and propose the alternative concretely. If you agree, say what you'd watch for during implementation.

Treat this as an architectural review for a one-pager I'm writing into `docs/architecture/`. Your output should help me write that one-pager — verdict + reasoning + concrete implementation notes + risks.
