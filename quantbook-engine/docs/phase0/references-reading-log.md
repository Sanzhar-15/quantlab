# Phase 0 references reading log

**Status:** AGENDA (post-R8c sprint, 2026-05-11) — file inventory complete, structured deep-read deferred to a dedicated session before Week 3.

The spec's Week 1 Days 5-7 deliverable was deep reading of the reference engines that inform Quantbook's design. R1-R7 of the recovery sprint covered the immediate audit findings but didn't have the multi-hour focus block needed to do justice to the reference reading. This document is the **agenda** for that dedicated session — file paths are confirmed, key questions are written, and the adoption matrix is sketched. A future contributor (or me in a fresh session) can use this as the entry point.

## Why the agenda-first format

Per the opus-architecture audit finding #15, Week 3 (range-node + Amendment A4 + Amendment A5) is the highest-architectural-risk week. Range-node compaction is the load-bearing perf insight (without it, 25M-cell ≤100ms is mathematically impossible). The deep-read MUST happen before Week 3 Day 1, not during.

The agenda below names the exact files, the questions each reading must answer, and the decisions each section feeds into. Total estimated reading time: 4-6 hours. Output of the deep-read sprint: this file expanded to ~600 lines with concrete citations + the adoption matrix populated.

## Reference repos (all cloned to `.references/`, gitignored)

| Repo | Path | Why | License |
|---|---|---|---|
| Formualizer | `.references/formualizer/` | Closest match — Rust + Arrow + range-graph + range nodes from week 1 | MIT (per Cargo.toml in clone) |
| IronCalc | `.references/ironcalc/` | Mature full spreadsheet engine, dual-licensed; for parser + functions | MIT or Apache-2.0 |
| HyperFormula | `.references/hyperformula/` | TS reference for dependency-graph + range-mapping algorithms; we read the docs + the TS source for algorithm shape | GPLv3 / commercial — DO NOT vendor; read only for algorithm intuition |

**Critical reminder:** these are **READ NOT VENDOR**. HyperFormula in particular is GPLv3 — we extract algorithm patterns, not code. Provenance for any non-trivial lift goes into `docs/legal/<source>-provenance.md` (gitignored per CORR-10 until ship-prep).

---

## Section 1 — Formualizer engine/graph (the range-node implementation)

**Path:** `.references/formualizer/crates/formualizer-eval/src/engine/`

**Reading list:**
- `mod.rs` — engine entry; identify the top-level types and how the graph hangs off them.
- `graph/mod.rs` — graph module entry.
- `graph/range_deps.rs` — **THE critical file.** How range dependencies get expressed as graph edges. This is the implementation of the algorithm Quantbook A5 falsifies.
- `graph/formula_analysis.rs` — how formulas decompose into the (cell-refs, range-refs) tuple that becomes graph edges.
- `graph/snapshot.rs` — the graph dump format. Direct inspiration for Quantbook A4 structural graph-dump assertions.
- `range_deps.rs` (top-level) — companion structures.
- `csr_edges.rs` — compressed-sparse-row edge storage; expect 1k LOC of bit-packing tricks for the dirty-set propagation.
- `delta_edges.rs` — incremental edge update on cell write.
- `interval_tree.rs` — likely the range-overlap query structure.
- `arena.rs` + `arena/` — node allocation.

**Questions to answer:**
1. How does Formualizer represent `SUM(A:A)` — as a single RangeRef edge or exploded into per-cell edges? (Spec answer: must be single edge. Verify.)
2. What's the data structure that lets edits to `A500` find dependents without a full vertex scan? (Spec answer: per-stripe index. Verify against `interval_tree.rs` + `csr_edges.rs`.)
3. How does Formualizer chunk dirty propagation? Does it work per-chunk or per-cell?
4. What's the `snapshot.rs` dump format? Can we crib it for A4's structural assertion tests?
5. Where does the range-node split/merge logic live? (Quantbook A1 falsifier reproduces this; we need to know the operations and their cost.)
6. How does Formualizer handle whole-column refs (`A:A`) vs bounded ranges (`A1:A100`)? Same edge type or different?

**Decisions this feeds:**
- `crates/ql-calcgraph` (Week 3 Days 1-3) — CellNode, RangeNode, FormulaRegionNode shape.
- Amendment A1 (Week 4 Day 6) — region split/merge falsifier benchmark structure.
- Amendment A4 (Week 3 Day 6) — three structural graph-dump assertions.
- Amendment A5 (Week 3 Day 6) — range-node prefix-SUM near-linear edge growth.

**Adoption call:** to be filled in deep-read sprint. Expected: LIFT the per-stripe index pattern verbatim into `ql-calcgraph/src/stripes.rs`; ADAPT the range-deps algorithm for Quantbook's FormulaRegionNode; INVENT the `chunked_reduce_chunks_processed` instrumentation.

---

## Section 2 — Formualizer stripes (the compressed range-index)

**Path:** `.references/formualizer/crates/formualizer-eval/src/stripes.rs` (46 lines — small, focused)

**Reading list:** the whole file in one sitting.

**Questions:**
1. What's the stripe granularity (rows-per-stripe)?
2. How are stripes indexed for "given a cell `A500`, find all stripes that contain row 500"?
3. What's the upper bound on stripe count vs sheet height? (matters for the A5 near-linear claim)
4. Does Formualizer compact stripes when ranges merge?

**Decisions this feeds:**
- `crates/ql-calcgraph/src/stripes.rs` (Week 3 Days 1-3).
- Amendment A5 falsifier — what near-linear means quantitatively.

**Adoption call:** likely LIFT the stripe granularity heuristic; reimplement against Quantbook's chunk layout (16,384 rows default).

---

## Section 3 — Formualizer arrow_store (Arrow-backed columnar storage)

**Path:** `.references/formualizer/crates/formualizer-eval/src/arrow_store/mod.rs` (**6669 lines** — biggest single file in the agenda)

**Reading strategy:** can't read 6669 lines in one sitting. Strategy:
1. First pass: `grep -nE "^(impl|pub fn|pub struct|pub enum)"` to map the API surface (~30 min).
2. Identify the 10-15 load-bearing functions/structs.
3. Read those in depth (2 hr).
4. Skim the rest for patterns that the API surface hints at.

**Questions:**
1. How does Formualizer represent a column? `Vec<Arc<dyn Array>>` chunks like Quantbook plans? Different?
2. What's the overlay/edit pattern for cell writes vs chunk replace? (Quantbook spec: SparseOverlay btreemap per chunk; verify the cost model matches.)
3. How does Formualizer handle the heterogeneous-type-per-column case (Excel allows it; Arrow doesn't natively)?
4. What's the read-merge code path (overlay-first, base-fallback)?
5. How does Formualizer chunk for cache locality? Power-of-2? Heuristic?
6. Does it use `arrow-buffer::Buffer` directly or only through `arrow_array::*`?

**Decisions this feeds:**
- `crates/ql-storage` (Week 2 Days 3-4 — NEXT after this sprint) — Workbook, Sheet, ColumnStore, SparseOverlay shape.
- Amendment A7 (Week 4 Day 6) — chunk-size sweep boundary choices.
- Phase 0 OG-02 hot path (Week 4) — kernel access patterns.

**Adoption call:** strong LIFT signal expected. This is the closest Quantbook predecessor.

---

## Section 4 — HyperFormula RangeMapping + Graph + TopSort

**Paths:**
- `.references/hyperformula/src/DependencyGraph/RangeMapping.ts` (the algorithm spec)
- `.references/hyperformula/src/DependencyGraph/Graph.ts` (graph data structure shape)
- `.references/hyperformula/src/DependencyGraph/RangeVertex.ts` (range-node anatomy)
- `.references/hyperformula/src/DependencyGraph/TopSort.ts` (topological scheduler)
- `.references/hyperformula/src/DependencyGraph/DependencyGraph.ts` (top-level orchestrator)
- `.references/hyperformula/src/DependencyGraph/CellVertex.ts` (cell-node anatomy for comparison)
- `.references/hyperformula/src/DependencyGraph/FormulaVertex.ts` (formula-node anatomy)
- `.references/hyperformula/src/DependencyGraph/AddressMapping/` (per-sheet sparse storage)
- HyperFormula online docs on dependency-graph (cite specific guide URL when reading).

**HyperFormula RangeMapping doc-comment (verbatim, captured 2026-05-11):**

> Maintains a per-sheet map from serialized start/end coordinates to `RangeVertex`.
> - Every range vertex in dependency graph should be stored in this mapping.
> - Guarantees uniqueness: one vertex per distinct rectangle, enabling cache reuse.
> - Implements "smaller prefix + tail row" optimization: if A1:A4 exists, A1:A5 depends on it + only A5.
> - RangeVertex stores cached results for associative aggregates (SUM, COUNT) and criterion functions.

That last bullet is the prefix-SUM optimization Amendment A5 quantifies (100k `SUM(A1:Ax)` formulas produce <2× formula count in edges, not quadratic).

**Questions:**
1. What does the "serialized start/end coordinates" key look like? Plain string concatenation, hash, packed integer?
2. How is `Maybe<AdjustVerticesOperationResult>` returned to indicate "split happened" vs "merged" vs "size-changed"? Quantbook's region split/merge falsifier (A1) needs this taxonomy.
3. How does HyperFormula's `TopSort` handle the cycle case? (Quantbook v1 ships iteration-style cycle handling; we want to know HF's algorithm.)
4. How does `Graph.ts` represent edges — adjacency list per vertex, or central edge store? (Spec lock: hand-rolled compact adjacency vectors; verify the trade-off.)

**Decisions this feeds:**
- `ql-calcgraph` range-node shape decision.
- Amendment A5 (prefix-SUM benchmark) baseline.
- `ql-calcgraph` topological scheduler.
- Architecture lock T1-D02 (hand-rolled vs petgraph): verify HF's choice and the reasoning.

**Adoption call:** ADAPT the prefix-tail optimization to Rust; INVENT the FormulaRegionNode integration (HyperFormula doesn't have this concept).

**Legal note:** HyperFormula is GPLv3. We READ for algorithm intuition. No verbatim copy of code, identifiers, or comment text into our codebase. Anything we LIFT goes into `docs/legal/hyperformula-provenance.md` (gitignored until ship-prep) with the exact license-compatible justification.

---

## Section 5 — IronCalc parser (Pratt parser + token taxonomy)

**Path:** `.references/ironcalc/base/src/expressions/parser/`

**Reading list:**
- `mod.rs` — parser entry; identify the top-level Parser type.
- `lambda.rs` — LAMBDA-specific parsing.
- `static_analysis.rs` — name resolution / structural analysis post-parse.
- `stringify.rs` — AST → A1 string roundtrip (Quantbook needs this for save).
- `move_formula.rs` — formula adjustment when columns/rows insert (Quantbook will need this in Phase 6).
- `../lexer/` (parent's `expressions/lexer/`) — token taxonomy.
- `../token.rs` — Token enum.
- `../types.rs` — typed AST node enum.

**Questions:**
1. What's IronCalc's token taxonomy? Compare against Quantbook's planned set (A1, R1C1, Sheet1!A1, 'Sheet 1'!A1, ranges A1:B10, structured refs Sales[Revenue], named refs, operators, parens, function names, string literals, number literals).
2. How does IronCalc handle `=AI(...)` today? (Probably it doesn't — Quantbook reserves it per CORR-06.)
3. What's the Pratt operator-precedence table?
4. How does IronCalc parse structured table refs `Sales[Revenue]`?
5. How does it parse Excel's nested-quote-in-quoted-sheet-name (`'Sheet ''1'''!A1`)?
6. AST → A1 round-trip preservation: does IronCalc preserve original token style (`R1C1` ↔ A1) or normalize?

**Decisions this feeds:**
- `crates/ql-formula-syntax` (Week 2 Days 5-6 — IMMEDIATELY AFTER ql-storage) — Token, Lexer, Pratt Parser, AST, A1 normalization, AI() reservation.
- 100 parser tests (spec Week 2 Day 5-6 target).

**Adoption call:** LIFT the operator-precedence table verbatim (it's an Excel-defined constant, not novel IP); ADAPT the structured-ref parser; INVENT the AI() reservation.

---

## Section 6 — Cross-cutting (what we INVENT, not copy)

These are Quantbook-original concepts that no reference engine has. Reading the references HELPS us understand the gap, but the implementation is greenfield.

1. **`FormulaRegionNode`** — a region of cells with the same formula fingerprint, sharing one graph vertex instead of one-per-cell. None of Formualizer/IronCalc/HyperFormula have this; it's a Quantbook bet on dense formula-region performance. Amendment A1 (Week 4) is the falsifier.

2. **AI() parser reservation** (CORR-06) — keyword reserved at parser level, returns `Error(AINotAvailable)` until v2.

3. **`terminal://` connector trait** — Quantbook's specific market-data integration with the Terminal product (founder's other app). No reference engine has this.

4. **`qb.show(df)` BoundFrame** — explicit Python ↔ sheet binding without magical mutation. No reference engine has this; it's a fusion-thesis specific design.

5. **`.qbook/` directory storage** with `workbook.toml` envelope + jsonl-per-cell-concern — Formualizer / IronCalc use single-file or different structures; HF doesn't ship a file format.

---

## Adoption matrix (to be populated post-deep-read)

The Phase 0 plan's per-subsystem source-matrix lives at `_QUANTBOOK-MASTER-PLAN.md` §7.7. After the deep-read sprint, expand here with concrete per-file citations and the LIFT / ADAPT / INVENT call for each subsystem.

| Subsystem | Closest reference | LIFT (verbatim adapt) | ADAPT (idea only) | INVENT |
|---|---|---|---|---|
| Range-node compaction | HyperFormula RangeMapping + Formualizer engine/graph | Prefix-tail edge sharing (pattern) | Quantbook-specific RangeNode shape (Rust + Arrow) | FormulaRegionNode |
| Stripe index | Formualizer stripes.rs | Stripe granularity heuristic (pending verification) | Chunk-aligned to ql-storage 16k chunks | — |
| Arrow column store | Formualizer arrow_store | Chunk-replace-not-cell-mutate pattern | SparseOverlay per chunk | — |
| Pratt parser | IronCalc parser | Operator-precedence table | Token taxonomy + structured-ref parser | AI() reservation |
| Topological scheduler | HyperFormula TopSort | Algorithm shape | Quantbook chunk-aware scheduling | Chunked dirty-set propagation |
| Graph dump | Formualizer engine/graph/snapshot.rs | Dump format | A4 assertions | `chunked_reduce_chunks_processed` |

**Note:** the "LIFT verbatim" column is conservative. For GPLv3 sources (HyperFormula), it means "pattern only, no code or comment text." For MIT/Apache (Formualizer, IronCalc), it can mean "translated near-verbatim" — but every such lift gets a per-file provenance entry under `docs/legal/<source>-provenance.md` when ship-readiness starts.

---

## Open process items

- [ ] Schedule the 4-6 hour deep-read sprint. Recommendation: Week 2 Day 5 morning (before ql-formula-syntax starts) or Week 3 Day 0 (dedicated prep day).
- [ ] After the deep-read, expand each section above to ~80-150 lines with concrete file:line citations and direct quotes (where license permits).
- [ ] Populate the adoption matrix's "Closest reference" column with line ranges, not just paths.
- [ ] If the deep-read surfaces a contradiction with a Round 7 lock, open a CORR-20 entry in `_round-7-decisions-log.md`.

## Files cloned for this agenda

```
.references/
├── formualizer/      # github.com/PSU3D0/formualizer (MIT, depth=1)
├── ironcalc/         # github.com/ironcalc/IronCalc (MIT or Apache, depth=1)
└── hyperformula/     # github.com/handsontable/hyperformula (GPLv3 — read-only, no code lift)
```

All three are gitignored via `quantbook-engine/.gitignore` (`.references/` entry).
