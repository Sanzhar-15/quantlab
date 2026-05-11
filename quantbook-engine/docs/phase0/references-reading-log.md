# Phase 0 references reading log

**Status:** DEEP-READ COMPLETE (Week 3 Day 0, 2026-05-11) — all four sections read; adoption matrix populated; five plan corrections (CORR-21..CORR-25) raised below.

The spec's Week 1 Days 5-7 deliverable was deep reading of the reference engines that inform Quantbook's design. R1-R8 of the recovery sprint covered immediate audit findings but didn't have the multi-hour focus block needed for the reading. This document captures the deep-read sprint output: per-section findings with file:line citations, the populated adoption matrix, and the plan corrections the reading surfaced.

**Total reading volume:** ~14,500 lines across three reference repos. Three parallel research agents executed Sections 1, 3, and 4 with explicit question lists; Section 2 read directly; Section 5 deferred (it only feeds the Phase B parser session, not Week 3 calcgraph).

## Reference repos

| Repo | Path | Why | License |
|---|---|---|---|
| Formualizer | `.references/formualizer/` | Closest match — Rust + Arrow + range-graph from week 1 | MIT |
| IronCalc | `.references/ironcalc/` | Mature spreadsheet engine, dual-licensed; for parser + functions | MIT or Apache-2.0 |
| HyperFormula | `.references/hyperformula/` | TS reference for dependency-graph + range-mapping algorithms; **GPLv3 — READ ONLY** | GPLv3 / commercial |

**Provenance:** anything LIFTED into Quantbook code with non-trivial inspiration from a reference gets a per-file entry under `docs/legal/<source>-provenance.md` (gitignored per CORR-10 until ship-prep).

---

## Section 1 — Formualizer engine/graph (Rust, MIT)

**Files read in depth:**
- `crates/formualizer-eval/src/engine/csr_edges.rs` (CSR edge storage)
- `crates/formualizer-eval/src/engine/delta_edges.rs` (incremental edge buffer; 540 lines)
- `crates/formualizer-eval/src/engine/interval_tree.rs` (range overlap structure)
- `crates/formualizer-eval/src/engine/graph/range_deps.rs` (365 lines — stripe registration)
- `crates/formualizer-eval/src/engine/graph/formula_analysis.rs` (530 lines — AST decomposition)
- `crates/formualizer-eval/src/engine/graph/mod.rs` (3422 lines — graph orchestrator)
- `crates/formualizer-eval/src/engine/graph/snapshot.rs` (18 lines — per-vertex undo state)
- `crates/formualizer-eval/src/engine/graph/sheets.rs` + `names.rs`
- `crates/formualizer-eval/src/engine/scheduler.rs` (Tarjan + Kahn layering)
- `crates/formualizer-eval/src/engine/topo/pk.rs` (Pearce-Kelly dynamic topo, optional)
- `crates/formualizer-eval/src/engine/vertex.rs` + `vertex_store.rs` (VertexKind, append-only ID space)
- `crates/formualizer-eval/src/engine/sheet_index.rs` (axis interval-tree for cell-in-rect queries)
- `crates/formualizer-eval/src/engine/eval.rs` (scheduling, parallel layers, cycle handling)

### Q1. How does Formualizer represent `SUM(A:A)`?

**ONE compressed range entry, NOT N cell edges.**

- AST decomposition: `engine/graph/formula_analysis.rs:150-220`. Unbounded ranges always stay compressed; bounded ranges expand to per-cell edges only if cell count `<= config.range_expansion_limit`.
- Registration: `engine/graph/range_deps.rs:36-192` does two things:
  1. `self.formula_to_range_deps.insert(dependent, ranges.to_vec())` — records the canonical `SharedRangeRef` list per formula.
  2. For each range, inserts the formula's `VertexId` into one `StripeKey → FxHashSet<VertexId>` bucket per touched stripe. For `A:A` this is one entry: `StripeKey { sheet_id, stripe_type: Column, index: 0 }`.

There is **no `RangeVertex` allocated** for `A:A`. The `VertexKind::Range` / `VertexKind::InfiniteRange` enum slots exist (`engine/vertex.rs:47-51`) but `engine/eval.rs:4760-4766` returns `Number(0.0)` for them — they are dead scaffolding.

### Q2. What lets a write to `A500` find dependent ranges?

**A stripe map keyed per-row, per-column, optionally per-256×256-block.** Granularity is one stripe per row / per column / per block — NOT per-chunk-of-N-rows.

- `engine/graph/mod.rs:159-160`: `stripe_to_dependents: FxHashMap<StripeKey, FxHashSet<VertexId>>`.
- `StripeKey { sheet_id, stripe_type: Row|Column|Block, index: u32 }` at `engine/graph/mod.rs:80-92`.
- `BLOCK_H = BLOCK_W = 256` at `engine/graph/mod.rs:95-96`. Block stripes only when `config.enable_block_stripes` AND `height>1 && width>1`.
- **Shape heuristic at registration** (`range_deps.rs:120-191`):
  - If `enable_block_stripes && h>1 && w>1` → block stripes.
  - Else if `height > width` → column stripes (one entry per column).
  - Else → row stripes.
  - So `SUM(A1:A1000)` registers 1000 row-stripe entries OR 1 column-stripe entry depending on shape.
  - `SUM(A:A)` → 1 column stripe (cheap).
  - `SUM(A1:Z1)` → 1 row stripe.
- **Query path** `collect_range_dependents_for_rect` at `engine/graph/mod.rs:2754-2837`: union all touched col/row/block stripes into a candidate set, then **re-check each candidate** against `formula_to_range_deps` to drop false positives (the stripe map is coarser than the range). Precision-check is critical.

`engine/sheet_index.rs:38-46` is a separate interval tree per sheet+axis — used for the **opposite direction** ("given a range, find all cell vertices in it" — viewport, row/col insert/delete). Not the structure that answers "write to A500 → which formulas."

### Q3. Cycle detection?

**Two layers:**

1. **Per-edit, cheap**: direct self-reference check at `engine/graph/mod.rs:1451-1454` (`if new_dependencies.contains(&addr_vertex_id) { return Err(Circ) }`) + recursive walk through named ranges at `mod.rs:1456-1462` (`name_depends_on_vertex`).
2. **Per-eval, Tarjan SCC on dirty subset** at `engine/scheduler.rs:88-239`. Iterative-stack Tarjan tracks `indices`, `lowlinks`, `on_stack`. SCCs of `len>1 || self_loop` go to `cycled` bucket at `scheduler.rs:373-389`; rest to layer-building.
3. **Optional, on-edit-time DAG maintenance**: `engine/topo/pk.rs:131-204` Pearce-Kelly dynamic toposort when `config.use_dynamic_topo` is set. Budgeted DFS; returns `Err(Cycle)` immediately.

### Q4. Recompute schedule?

**Tarjan SCC → separate cycles → Kahn's algorithm over acyclic SCCs producing parallel-friendly layers.** `scheduler.rs:26-54` `create_schedule(vertices)`:
1. `tarjan_scc(vertices)` over the dirty subset only.
2. `separate_cycles(sccs)` → `(cycles, acyclic)`.
3. `build_layers(acyclic_sccs)` — Kahn's: in-degree restricted to subset (`scheduler.rs:406-426`); VecDeque queue of in-deg-0 nodes; pop a **full layer at a time** so each layer is mutually independent + parallelizable (`scheduler.rs:438-471`). Each layer sorted for determinism.
4. Per-cell, not per-chunk. `vertices = graph.get_evaluation_vertices()` = dirty ∪ volatile, filtered to formula kinds (`mod.rs:1856-1877`).

### Q5. VertexId space?

**Append-only u32, never reused; deletions are tombstone bits.** `engine/vertex_store.rs:130-132`:
```
pub const FIRST_NORMAL_VERTEX: u32 = 1024;
pub const RANGE_VERTEX_START: u32 = 0;
pub const EXTERNAL_VERTEX_START: u32 = 256;
```
`allocate` does `VertexId(self.len as u32 + FIRST_NORMAL_VERTEX)` (`vertex_store.rs:209-221`). No free list. `mark_deleted` flips bit `0x04` (`:418-426`); `vertex_exists_active` returns true only if active + not deleted. The 0..1024 reserved range is unused.

### Q6. Graph dump?

**There is no whole-graph dump.** Debug surface is sparse:
- `VertexStore::debug_vertex(id) -> String` returns `format!("{view:?}")` of a `VertexView` at `engine/debug_views.rs:76-89`.
- `VertexStore::debug_range(start, count)` is just `map(debug_vertex)` at `:217-224`.
- Test-only accessors on `DependencyGraph`: `formula_to_range_deps()` and `stripe_to_dependents()` at `engine/graph/range_deps.rs:25-34`, plus `cell_to_vertex()` at `mod.rs:2956-2961`.

**No `to_dot`, no `Display`/`Debug` on `DependencyGraph`, no JSON serializer.** Tests assert by inspecting typed maps directly — not by parsing a serialized form.

### Q7. Range-vertex aggregate caching?

**Not implemented in Formualizer.** `VertexKind::Range` slots exist but eval treats them as inert (`eval.rs:4760-4766` returns `Number(0.0)`). `formula_to_range_deps` stores range refs but no aggregate values. `SUM(A:A)` recomputes from scratch every time. The only "cache" with cache in the name is `schedule_cache` (`eval.rs:784-6164`) — caches the **scheduling plan** (layer ordering), not aggregate values.

This is the key gap that HyperFormula fills with its `RangeVertex.functionCache` (per-function-name HashMap on each range node).

### Q8. `interval_tree.rs` API?

- Type: `IntervalTree<T> { map: BTreeMap<u32, Vec<IntervalNode<T>>>, size: usize }` where `IntervalNode { high: u32, values: HashSet<T> }` (`interval_tree.rs:21-34`).
- Query: `query(q_low, q_high) -> Vec<(u32, u32, HashSet<T>)>` — overlaps. Implementation at `:83-93` iterates `self.map.range(..=q_high)`, keeps nodes with `node.high >= q_low`. **Linear in matching prefix**, NOT O(log n + k) as the doc-comment promises.
- Mutation: `insert/remove`, `entry(low,high).or_insert_with(...)`, `bulk_build_points(items)` (only valid when tree empty, else falls back to per-element insert).
- Built incrementally. Used by `SheetIndex` with `T = VertexId`; only stores point intervals `[row,row]` and `[col,col]` (`sheet_index.rs:70-81`).

### Q9. CSR + delta edges?

**CSR is the committed snapshot, delta is the pending mutation buffer with periodic compaction.** Composed in `CsrMutableEdges` (`engine/delta_edges.rs:412-427`):
- `base: CsrEdges` + `delta: DeltaEdgeSlab`.
- `DeltaEdgeSlab`: `additions: FxHashMap<VertexId, FxHashSet<VertexId>>` + `removals: FxHashMap<...>` + `op_count` + `coord_changed: bool` (`:287-300`).
- Last-op-wins semantics: adding cancels prior removal, vice versa (`:314-333`).
- Read: `merged_view` copies CSR out-edges, applies removals, extends with additions, dedupes, sorts (`:336-352`).
- Compaction threshold: `op_count >= 1000` OR `coord_changed` (`:355-357`). Rebuild via `apply_to_csr` rebuilds fresh CSR + clears delta (`:378-398`).
- Batch mode (`begin_batch()`/`end_batch()`) defers rebuild for bulk editors (`:530-540`).
- Base CSR stores **reverse edges (incoming) eagerly** for O(1) `in_edges(v)` (`csr_edges.rs:300-313`, `460-478`) — but only valid when `delta_size == 0`; otherwise scheduler falls through to scan path (`mod.rs:2998-3015`, instrumented as `dependents_scan_fallback`).

### Surprises that contradict the original plan

1. **The "stripe" concept is NOT what `stripes.rs` does.** `stripes.rs` (46 lines) is `NumericChunk` / `CellChunk` borrowed-view types for SIMD reductions — borrowed slice + optional validity mask. The **actual** stripe-index concept lives in `engine/graph/mod.rs:80-100` + `range_deps.rs` as `StripeKey { Row|Column|Block, index }`.
2. **Stripes are per-single-row or per-single-column** (with optional 256×256 blocks), NOT per-chunk-of-N-rows. Original assumption was wrong.
3. **`VertexKind::Range` is dead code.** Range deps live in sidecar maps, not in the vertex array.
4. **No range-aggregate caching** in Formualizer — recomputes every time. HyperFormula has this; Formualizer does not.
5. **Cycle detection is dual** (per-edit cheap + per-eval Tarjan), not one or the other.
6. **Reverse edges are eager in CSR base, lazy in delta path** — perf characteristic flips with op count.
7. **VertexId 0..1024 is reserved but unused** — abandoned feature reservation.
8. **No DOT/JSON/text dump exists.** Don't expect to crib a format.
9. **`interval_tree.rs` doc overstates performance** (claims O(log n + k), implementation is linear-prefix scan).
10. **`bulk_build_points` only fast-paths when tree is empty** — incremental cost after first build.

---

## Section 2 — Formualizer `stripes.rs` (read directly, 46 lines)

**File:** `crates/formualizer-eval/src/stripes.rs`

**Content:** declares `NumericChunk<'a>` and `CellChunk<'a>` for SIMD reductions:
```rust
pub struct NumericChunk<'a> {
    pub data: &'a [f64],
    pub validity: Option<ValidityMask<'a>>, // None => all valid
}
pub enum ValidityMask<'a> { Bits(&'a [u64]), Bools(&'a [bool]) }
pub enum CellChunk<'a> {
    Mixed(&'a [formualizer_common::LiteralValue]),
    Numbers(&'a [f64]),
}
```

**Not the range-stripe index.** That lives in `engine/graph/mod.rs` (see Section 1 Q2). The naming collision is misleading.

For Quantbook: this **IS** a useful pattern for the kernel hot path — a borrowed chunk view with optional validity mask hands directly to SIMD code. Worth lifting for `ql-exec` (Week 4) where SIMD kernels need a uniform borrowed-chunk type that works for both base Arrow arrays and overlay-merged chunks.

---

## Section 3 — Formualizer `arrow_store/mod.rs` (Rust, MIT)

**Files read:**
- `crates/formualizer-eval/src/arrow_store/mod.rs` (6669 lines, API-surface scan + 15 hot-spot deep reads)
- `crates/formualizer-eval/src/engine/range_view.rs` (1315 lines — chunk iteration lives here, NOT in arrow_store)
- `crates/formualizer-eval/src/engine/arrow_ingest.rs` (ingest builder wiring)

### Architecture in one diagram

```
SheetStore (mod.rs:315)
  └── ArrowSheet (mod.rs:302)            // has chunk_rows, chunk_starts
       └── ArrowColumn (mod.rs:264)      // dense Vec<ColumnChunk> + sparse FxHashMap<usize, ColumnChunk>
            └── ColumnChunk (mod.rs:74)  // 4 lanes + type_tag + 2 overlays
                 ├── numbers:  Option<Arc<Float64Array>>
                 ├── booleans: Option<Arc<BooleanArray>>
                 ├── text:     Option<ArrayRef>   // Utf8
                 ├── errors:   Option<Arc<UInt8Array>>
                 ├── type_tag: Arc<UInt8Array>    // always present
                 ├── overlay:          Overlay   // user edits
                 └── computed_overlay: Overlay   // formula/spill outputs
```

**All columns share identical chunk boundaries** (mod.rs:735-757 — panics on mismatch). This is the keystone invariant that makes lockstep iteration over chunks across multiple columns possible.

### Q1. Heterogeneous types

**4 parallel lanes + 1 type_tag byte per row.** No UnionArray, no StructArray. Each row's true type is its tag; the lane is null where the tag doesn't match. `Option<Arc<...>>` per lane means all-text columns never allocate a Float64Array — `numbers_or_null()` (mod.rs:105-115) caches via `OnceCell` only if asked.

`TypeTag`: `Empty=0, Number=1, Boolean=2, Text=3, Error=4, DateTime=5, Duration=6, Pending=7`. DateTime/Duration share the numeric lane as Excel serials (mod.rs:441-447, 599-622) so date-heavy columns preserve SIMD numeric path.

### Q2. Overlay pattern

**Two overlays per chunk** (mod.rs:1809-2060, 2200-2616):
- `ch.overlay` — user edits (`set_cell_value` writes here)
- `ch.computed_overlay` — formula/spill outputs
- Read cascade: `user → computed → base` (mod.rs:3340-3343)

`Overlay` has `points: HashMap<usize, OverlayValue>` (single-cell edits) + `fragments: Vec<OverlayFragment>` (range edits). `OverlayFragment` has three encodings: SparseOffsets / DenseRange / RunRange (mod.rs:1136-1152). Self-normalizing: `apply_fragment` (mod.rs:1873-1881) removes overlapping points + subtracts overlapping fragments before pushing.

**Merge into base** via `maybe_compact_chunk` (mod.rs:3634-3833). Triggered when `overlay.len() > chunk_len/50 || overlay.len() > 1024` (caller at eval.rs:3467-3469). Rebuilds the four lanes via fresh Arrow builders.

### Q3. Chunk size

**32 * 1024 = 32768 default** (eval.rs:1509, 3394), configurable per sheet via `ArrowSheet.chunk_rows` (mod.rs:311). 2× our 16384. Doc-comment (mod.rs:307-311): "For Arrow-ingested sheets this matches the ingest chunk_rows. For sparse/overlay-created sheets this defaults to 32k to avoid creating thousands of tiny chunks during growth."

### Q4. `range_view` iterator

**Returns `ArrayRef` slices (zero-copy Arrow `.slice()`), NOT `&[f64]`.** Path:
- `ArrowSheet::range_view(sr,sc,er,ec) -> RangeView<'_>` at mod.rs:3298
- `RangeView::iter_row_chunks() -> RowChunkIterator` at range_view.rs:477
- Yields `ChunkSlice { row_start, row_len, cols: Vec<ChunkCol> }` where `ChunkCol` is `{ numbers/booleans/text/errors: Option<ArrayRef>, type_tag: ArrayRef }`.
- For SIMD, callers do `Float64Array::values()` to get `&[f64]` from the underlying Buffer.

Higher-level views fold overlays in: `numbers_slices`/`booleans_slices`/`text_slices`/etc. at range_view.rs:628-683. Fast path returns `Arc::new(base.clone())` (refcount-only). Single-cell fast path `get_cell_value(abs_row, abs_col)` bypasses RangeView entirely (mod.rs:3323-3419).

### Q5. Lazy chunk allocation

**Three tiers:**
1. **Within a column**: `chunks: Vec<ColumnChunk>` (dense prefix) + `sparse_chunks: FxHashMap<usize, ColumnChunk>` (sparse tail). `chunk(idx)` checks dense then sparse (mod.rs:273-279).
2. **`ensure_row_capacity(target_rows)`** at mod.rs:3425-3483 does NOT eagerly densify — only updates `chunk_starts` + `grow_len_to` on materialized chunks (doc at :3422-3424).
3. **`ensure_column_chunk_mut(col, ch_idx)`** at mod.rs:3488-3510 is the lazy-allocate-on-write point. Past the dense end → `make_empty_chunk(len)` into the sparse map. `make_empty_chunk` (mod.rs:3537-3560) only allocates the `type_tag` UInt8Array of zeros; data lanes all `None`.

**Read from empty chunk** (range_view.rs:127-149): synthesize `new_null_array(...)` on the fly — no allocation into the column.

### Q6. Validity / nulls

**Layered:**
1. `type_tag` is the primary discriminator — never null. `Empty` (tag=0) is canonical blank. No NaN-tagging.
2. Per-lane Arrow null bits as secondary.
3. Whole-lane `None` when zero non-nulls.

`get_cell_value` checks tag, then dispatches to lane (mod.rs:3346-3418).

### Q7. Write path

**Push to overlay, never mutate base Arrow buffers** (eval.rs:3437-3473):
```rust
let ov = self.literal_to_overlay_value(&value);
let (ch_idx, in_off) = sheet.chunk_of_row(row);
let ch = sheet.ensure_column_chunk_mut(col, ch_idx)?;
let _ = ch.overlay.set(in_off, ov);                  // <-- the write
ch.computed_overlay.remove(in_off);                  // invalidate stale computed
let freed = sheet.maybe_compact_chunk(col, ch_idx, 1024, 50);  // maybe rebuild
```

`Overlay::set_scalar` (mod.rs:1860-1866) inserts to `HashMap<usize, OverlayValue>` + subtracts overlapping fragments. Arrow buffers are `Arc<...>` — never mutated in place. Compaction is copy-on-write at the chunk level.

### Q8. Bulk import path

`IngestBuilder` (mod.rs:329-767): row-by-row into Arrow builders, finish_chunk every `chunk_rows`. Three append flavors: `append_row_cells(&[CellIngest])`, `append_row_cells_iter(...)`, `append_row(&[LiteralValue])`. Lanes with non-null count == 0 after a chunk are **dropped entirely** (mod.rs:658-677) — preserves the all-null-lane optimization.

### Q9. Threading

`ArrowSheet` / `SheetStore` are `Send + Sync` by auto-derive (no `unsafe impl`). No internal `RwLock`. Engine takes `&mut Engine` for writes — single-writer borrow model. Rayon-parallel evaluation reads `&ArrowSheet`; writes serialize through `ensure_column_chunk_mut` after the parallel layer finishes.

### Q10. Invariants and SAFETY

Only one explicit `// SAFETY:` in arrow_store (range_view.rs:600 — `slice::from_raw_parts` for callback). Invariants enforced via **panics** at IngestBuilder boundary:
- All columns share identical chunk count + per-chunk row count (mod.rs:735-757, panics with `"ArrowSheet chunk misalignment"`).
- `chunk_starts.len() == columns[i].chunks.len()` in dense-aligned mode (mod.rs:4060-4064).
- Overlay normalization: no offset covered twice across points + fragments (mod.rs:2090-2105, `debug_is_normalized`).
- Lane consistency: when `non_null_X == 0`, lane MUST be `None` (mod.rs:658-677, 3777-3809).
- TypeTag unknown → `Empty` (silent fallback; slight no-fallbacks-rule concern but kept since type-tag bytes are internal-only).

### Patterns to LIFT vs ADAPT vs INVENT for Quantbook

| Pattern | Formualizer | Quantbook recommendation |
|---|---|---|
| Per-row `type_tag` (1 byte) | UInt8Array per chunk | **DEFER** — Quantbook v1 columns can stay Float64-only until heterogeneous workloads hit Phase 3 |
| 4 parallel lanes (num/bool/text/err) | `Option<Arc<...>>`, lazy | **DEFER** — same; revisit when adding Boolean/Text columns |
| `OnceCell` for lazy null lanes | per lane | **LIFT when adding lanes** — cheap pay-on-read |
| Sparse-chunks `FxHashMap<usize, ColumnChunk>` | tail-extended columns | **ADAPT** — our `Vec<ArrayRef>` works for dense Phase 0; revisit when spill outputs grow sparsely |
| **Two overlays per chunk (user + computed)** | `overlay` + `computed_overlay`, cascade `user → computed → base` | **LIFT for calcgraph integration (Phase 4 / OG-02 prep)** — formula outputs need a separate lifecycle from user edits |
| OverlayFragment 3 encodings (Sparse/Dense/Run) | adaptive | **INVENT-DIFFERENTLY** — keep our sparse-only `SparseOverlay` for Phase 0; revisit when fill-down hot path appears |
| Heuristic compaction `len/50 \|\| > 1024` | `maybe_compact_chunk` | **LIFT idea, ADAPT constants** — our chunk size is half (16k); maybe `len/30 \|\| > 1024` |
| Arrow `.slice()` for chunk borrowing | zero-copy | **LIFT** — verify our `iter_chunks` doesn't copy (it shouldn't) |
| All-columns-same-chunk-boundary invariant | panic on mismatch | **LIFT** — required for lockstep multi-column SIMD |
| `ChunkSlice` returns `Arc<ArrayRef>` | reference-counted | **EXPOSE BOTH** — Arrow for type-aware paths, `&[f64]` via `Float64Array::values()` for hot kernels |
| Single-writer, `Send+Sync` auto, no `RwLock` | single mut borrow | **LIFT** — our `ColumnStore` follows this already |
| `get_cell_value` direct fast path | bypasses RangeView | **ADD** — our `ColumnStore::read(row)` does this; verify it doesn't go through `iter_chunks` |
| `IngestBuilder` row-by-row | drops all-null lanes | **DEFER** — Phase 0 bench fixtures hand us full `Vec<Arc<dyn Array>>` directly; xlsx ingest is Week 4+ |

### Things to follow up on

1. Concurrent computed-overlay writes during rayon-parallel evaluation: how do parallel formulas merge results back into `computed_overlay`? Follow eval.rs:5426-5650.
2. `OverlayCascade::full_cover_dense_fragment` fast path (mod.rs:3152-3170 area).
3. Whether `zip_select` produces new Arrow buffers or reuses base when mask is mostly-false.
4. Cost of `slice_chunk` in `insert_rows`/`delete_rows` — is it O(chunks) or O(rows)?
5. `Pending` tag (7) usage — what triggers it? Probably "formula scheduled but not evaluated."
6. `chunk_rows` preservation across `insert_rows` — could break the fixed-size-except-last invariant.

---

## Section 4 — HyperFormula DependencyGraph (TypeScript, GPLv3)

**Legal reminder:** ALL findings below are descriptive/algorithmic, NOT code-lift candidates. TypeScript snippets are quoted purely for traceability.

**Files read:**
- `src/DependencyGraph/RangeMapping.ts` (the prefix-tail mechanism)
- `src/DependencyGraph/Graph.ts` (storage + dirty tracking)
- `src/DependencyGraph/RangeVertex.ts` (aggregate cache)
- `src/DependencyGraph/TopSort.ts` (iterative Tarjan SCC)
- `src/DependencyGraph/DependencyGraph.ts` (orchestration: lines 174-238, 540-567, 878-896, 947-1085)
- `src/DependencyGraph/AddressMapping/*.ts` (dense/sparse strategies)
- `src/DependencyGraph/collectAddressesDependentToRange.ts` (misleadingly named)
- `src/DependencyGraph/SheetReferenceRegistrar.ts` (cross-sheet placeholders)
- `src/Evaluator.ts` (calls topsort, handles cycles)
- `src/interpreter/plugin/NumericAggregationPlugin.ts:620-715` (where SUM exploits the cache)

### A. Prefix-tail "smaller-range" optimization

**Much narrower than the doc-comment claims.** Doc at `RangeMapping.ts:33` says "smaller prefix + tail row." Implementation at `RangeMapping.ts:217-232` (`findSmallerRange`) only checks `end.row - 1`:
```ts
const valuesRangeEndRowLess = simpleCellAddress(range.end.sheet, range.end.col, range.end.row - 1)
const rowLessVertex = this.getRangeVertex(range.start, valuesRangeEndRowLess)
if (rowLessVertex !== undefined) {
  const restRange = AbsoluteCellRange.fromSimpleCellAddresses(
    simpleCellAddress(range.start.sheet, range.start.col, range.end.row), range.end)
  return { smallerRangeVertex: rowLessVertex, restRange }
}
```
**One-step decrement only. Column-direction growth only.** If `A1:A4` exists and you register `A1:A6`, HF will look for `A1:A5`, NOT find it, and mark `A1:A6` as `bruteForce` (direct edges to all six cells). `A1:A4`'s cached SUM is NOT reused unless `A1:A5` exists first.

**Lookup data:** per-sheet `Map<string, RangeVertex>` keyed by serialized `(startCol, startRow, endCol, endRow)` (`RangeMapping.ts:40, 237`):
```ts
private rangeMapping: Map<number, Map<string, RangeVertex>> = new Map()
// key = `${start.col},${start.row},${end.col},${end.row}`
```

**`bruteForce` toggle** at `DependencyGraph.ts:202-213`:
```ts
const {smallerRangeVertex, restRange} = this.rangeMapping.findSmallerRange(range)
if (smallerRangeVertex !== undefined) {
  this.graph.addEdge(smallerRangeVertex, rangeVertexId)
  if (rangeVertex.bruteForce) {
    rangeVertex.bruteForce = false
    for (const cellFromRange of range.addresses(this)) {
      this.graph.removeEdge(this.fetchCell(cellFromRange), rangeVertexId)
    }
  }
} else { rangeVertex.bruteForce = true }
```
When no prefix exists → bruteForce: range depends directly on every cell. When a prefix later appears → swap representations, delete the direct edges. **Bounds edge count at O(range-size) regardless of how many times the range is registered/restructured.**

### B. RangeVertex aggregate cache

**Per-function-name HashMap on each RangeNode** (`RangeVertex.ts:14-32`):
```ts
private functionCache: Map<string, any>             // SUM, COUNT, MAX, MIN, AVERAGE, PRODUCT
private criterionFunctionCache: Map<string, CriterionCache>  // SUMIF/COUNTIF/AVERAGEIF
private dependentCacheRanges: Set<RangeVertex>      // cascade for criterion caches
```

**SUM lookup** at `NumericAggregationPlugin.ts:642-654`:
```ts
let value = rangeVertex.getFunctionValue(functionName) as (T | CellError | undefined)
if (value === undefined) {
  const rangeValues = this.getRangeValues(...)        // uses prefix-tail to combine cached_prefix + tail
  value = rangeValues.reduce(...)
  rangeVertex.setFunctionValue(functionName, value)
}
return value
```

Prefix-tail combination at `NumericAggregationPlugin.ts:682-715`: query smaller-range vertex's cache → push cachedValue → reduce only over tail. So `SUM(A1:A5) = cache(A1:A4) ⊕ A5` when hot — incremental aggregate.

**Invalidation is brute-force.** `RangeVertex.clearCache()` (`:104-109`) drops everything + recursively clears `dependentCacheRanges`. Evaluator triggers at:
- `Evaluator.ts:92` — full reevaluation of RangeVertex's recompute path
- `Evaluator.ts:104` — cycle handling
- `Evaluator.ts:129` — full-run topsort sweep

So **every dirty range vertex has its cache cleared during recompute, then lazily re-populated.** No "value didn't change" early-exit on the range side.

### C. Topological sort

**Iterative Tarjan SCC.** `TopSort.ts:18-92`: iterative-stack to avoid JS call-stack blowup. Tracks `entranceTime, low, parent, inSCC, nodeStatus, order, sccNonSingletons`.

- **Both whole-graph and subset modes**: `topSortWithScc()` at `Graph.ts:260-262` seeds with `getNodes()` (full graph, used at engine init in `Evaluator.run()`). `getTopSortedWithSccSubgraphFrom()` at `Graph.ts:271-279` seeds with dirty/volatile set (used for `partialRun` in `Evaluator.ts:44-54`).
- **Output**: `{ sorted: T[], cycled: T[] }` at `TopSort.ts:6-9`. Two buckets, single linear order, NOT parallel levels.
- **Cycle handling**: SCC `len>1 || self_loop` → cycled (`TopSort.ts:175-178`). Evaluator's `processVertexOnCycle` (`Evaluator.ts:102-112`) sets `CellError(ErrorType.CYCLE, undefined, vertex)`. **No iteration limit, no fixpoint.** Matches Quantbook Phase 0 design.
- **Smart change propagation**: `shouldBeUpdatedMapping` at `TopSort.ts:159-184` only recomputes a node if seed OR upstream `operatingFunction` returned `true` (value actually changed). Value-equality short-circuit baked into topsort — cheap.

### D. Graph data structure

**Per-vertex adjacency lists in a sparse array** (`Graph.ts:33-40`):
```ts
private nodesSparseArray: Node[] = []        // id -> Node
private edgesSparseArray: NodeId[][] = []    // id -> NodeId[] (per-node out-edges)
```

**Not a central edge store, not CSR.** Each `edgesSparseArray[id]` is a plain JS array of out-edge targets.

**Append-only IDs with tombstones**: `Graph.ts:148-154` `nextId` only grows; `removeNode` does `delete this.nodesSparseArray[id]` + `delete this.edgesSparseArray[id]`, leaving sparse holes — never reused.

**Acknowledged perf issues** in source comments:
- `Graph.ts:25-27`: "Idea for performance improvement: use Set<Node>[] instead of NodeId[][]"
- `TopSort.ts:172-174`: "Array.includes() is O(n) operation, which makes the whole algorithm O(n^2)"
- Edge insertion dedupes via `includes` at `Graph.ts:177-181` — O(out-degree) per add.

**Side buckets** stored externally:
- `infiniteRangeIds: Set<NodeId>` (`Graph.ts:55`)
- `dirtyAndVolatileNodeIds: ProcessableValue<{dirty, volatile}, Node[]>` (`Graph.ts:46-49`)
- `changingWithStructureNodeIds: NodeId[]` (`Graph.ts:61`) — OFFSET/INDEX/INDIRECT, redirty on row/col insert

### E. AddressMapping (per-sheet sparse storage)

**Two strategies, chosen per-sheet**:
- `DenseStrategy` (`DenseStrategy.ts:17-37`): `CellVertex[][]` indexed `[row][col]`; pre-allocates `height * width`.
- `SparseStrategy` (`SparseStrategy.ts:17-27`): `Map<colNumber, Map<rowNumber, CellVertex>>`.

**Default policy: `AlwaysDense`** (`Config.ts:37`). Threshold-based `DenseSparseChooseBasedOnThreshold` exists but is not default.

**Gap handling:** both tolerate missing cells. `EmptyCellVertex` created only when needed as a graph dependency target (`DependencyGraph.ts:252-264`).

**Row/col mutations:** Dense uses `Array.prototype.splice` per row (`DenseStrategy.ts:81-115`); Sparse rebuilds via tmpMaps (`SparseStrategy.ts:66-132`). Neither fast for large structural edits — known pain point.

### F. `collectAddressesDependentToRange` is misleadingly named

The function (`collectAddressesDependentToRange.ts:16-40`) does NOT answer "given a range edit, which vertices depend on it?" It returns the addresses INSIDE the range that a given vertex depends on. Used only **once** at `DependencyGraph.ts:555` in `setArrayEmpty` (array-shrinkage cleanup).

**Real range-edit dependency resolution** is the linear scan in `RangeMapping.truncateRanges` (`RangeMapping.ts:98-140`) + adjacency walks in `removeRows`/`removeColumns`. **No spatial index.** With N RangeVertices per sheet, every truncate is O(N).

### G. Cycle handling

**Terminal, no iteration.** `processVertexOnCycle` (`Evaluator.ts:102-112`) sets `CellError(ErrorType.CYCLE)` + bails. No `maxIterations` setting, no Phase 0/Phase 1 distinction. Range vertices on cycles just clear their cache (`Evaluator.ts:103-104`).

**Matches Quantbook Phase 0 design** (CycleError, no iteration).

### H. Cross-sheet vs same-sheet

**Graph itself is sheet-agnostic**: NodeIds globally allocated, edges cross sheets freely (`Graph.ts:165-182`).

**Storage is per-sheet keyed**: `AddressMapping` and `RangeMapping` both partition by sheet. `RangeMapping.rangeMapping: Map<number, Map<string, RangeVertex>>`.

**Cross-sheet references** go through `SheetReferenceRegistrar.ts:12-27`: placeholder sheet/strategy if the referenced sheet doesn't exist yet, upgraded in-place when the real sheet arrives.

**Infinite-range correction-on-write** (`DependencyGraph.ts:878-896`): every cell write linearly scans `getInfiniteRanges()` to check whether the touched address falls in any. **O(infinite-ranges) per cell write.**

### I. What contradicts the Quantbook design

Going through the original plan choices:

1. **`Vec<SmallVec<NodeId>>` adjacency**: strictly better than HF's `NodeId[][]`. HF acknowledges in comments. Win.
2. **Per-chunk dirty bitmap**: HF has nothing equivalent. Their dirty set is `NodeId[]` with lazy dedupe. Win.
3. **Stripe index (per-column → RangeNode IDs)**: HF has **nothing equivalent**. Their `truncateRanges` and `correctInfiniteRangesDependency` are linear scans. Win — but the right model is Formualizer's `StripeKey { Row|Column|Block, index }`, not HF's prefix-tail.
4. **Formula fingerprint memoization**: HF has nothing equivalent. The only "have we seen this formula?" is per-vertex `cachedCellValue` on `ScalarFormulaVertex` (`FormulaVertex.ts:247`).
5. **Kahn's algorithm on dirty subset**: HF uses iterative Tarjan SCC. Tarjan handles cycle detection in the same pass; Kahn does not. **Switch to Tarjan SCC for better cycle reporting → CORR-23 below.**
6. **CycleError, no Phase 0 iteration**: matches HF exactly.

**Two ideas worth porting from HF (algorithmic, not code):**

- **`shouldBeUpdatedMapping` short-circuit** in topsort postprocess — value-equality propagation. Cheap, and our dirty bitmap doesn't capture it. Worth adding.
- **`bruteForce` toggle** when registering ranges with no prefix — bounds RangeNode out-edges. Worth combining with our stripe-index approach.

### Doc-vs-code mismatches

1. `RangeMapping.ts:33` "smaller prefix + tail row" implies arbitrary prefix discovery. Actual: only `end.row - 1`.
2. `Graph.ts:103-118` `adjacentNodes` filter recomputes every call; hidden cost.
3. `Graph.ts:99` `existsEdge` uses `Array.includes` (O(out-degree)). Internal comments acknowledge.
4. `SparseStrategy.ts:15` honestly says "not necessarily constant set/lookup."
5. `TopSort.ts:172-174` self-acknowledged O(n²) due to `adjacentNodes.includes(t)` self-edge check.
6. `RangeVertex.clearCache` cascade via `dependentCacheRanges` is ONLY populated for criterion caches, not function caches. The comment makes this look general; it isn't.

---

## Section 5 — IronCalc parser (DEFERRED to Phase B parser session)

Not read this sprint. Section 5 only feeds the Pratt parser session (Phase B), which is deferred per CORR-20. When that session starts, read in this order: `parser/mod.rs`, `lexer/`, `parser/static_analysis.rs`, `parser/stringify.rs`, `parser/move_formula.rs`.

---

## Adoption matrix (populated)

| Subsystem | Closest reference | LIFT | ADAPT | INVENT |
|---|---|---|---|---|
| **Range-node deps** | Formualizer `engine/graph/range_deps.rs:36-192` | Stripe map `FxHashMap<StripeKey, FxHashSet<VertexId>>` with shape heuristic | Quantbook RangeNode wrapping the stripe entry (single Rust type) | FormulaRegionNode + chunk-aligned bitmap |
| **Stripe index** | Formualizer `engine/graph/mod.rs:80-100` (`StripeKey`) | StripeKey `{sheet_id, Row\|Column\|Block, index}`. Shape heuristic: `enable_block && h>1 && w>1` → block; else `h>w` → column else row. 256×256 block constants for non-Phase-0 | — | (Phase 0: skip block stripes for simplicity; revisit Week 4) |
| **Range aggregate caching** | HyperFormula `RangeVertex.ts:14-32` (function name → cached value) | Algorithm pattern only (GPLv3) — `HashMap<&str, AggregateValue>` per RangeNode; clear-all on dirty; lookup keyed by canonical function name | — | (Phase 0: NO aggregate caching; integrate Phase 4+) |
| **Range registration `bruteForce` toggle** | HyperFormula `DependencyGraph.ts:202-213` | Pattern only (GPLv3): if no prefix exists → direct cell edges; when prefix appears → swap edges | — | (Phase 0: defer; Phase 4+) |
| **CSR + delta edges** | Formualizer `engine/csr_edges.rs` + `delta_edges.rs` | Pattern of base-CSR + delta-buffer + compaction-on-threshold | (Phase 0: use simpler `Vec<SmallVec<NodeId>>` adjacency; revisit when edge count > 10M) | — |
| **Cycle handling** | Formualizer scheduler.rs + HF Evaluator | Tarjan SCC on dirty subset returning `(sorted, cycled)` | Adapt to our NodeId/Node types | (Phase 0: cycle → CycleError; no iteration) |
| **Topological scheduler** | Formualizer `engine/scheduler.rs:26-54` (Tarjan→Kahn-layers) | Iterative Tarjan SCC, then Kahn layering for parallel-friendly layers | (Phase 0: linear order is fine; Kahn layering is Week 4 perf concern) | — |
| **Value-equality short-circuit** | HyperFormula `TopSort.ts:159-184` (`shouldBeUpdatedMapping`) | Pattern only (GPLv3): downstream only recomputed if upstream changed | — | (Phase 0: defer) |
| **Two-overlay column store** | Formualizer arrow_store `overlay` + `computed_overlay` | Pattern: separate user-edit vs formula-output overlays, cascade `user → computed → base` | Adapt to our `SparseOverlay` | (Phase 0: single overlay is fine; revisit Week 4 OG-02 prep) |
| **All-columns-same-chunk-boundary invariant** | Formualizer mod.rs:735-757 | Panic on mismatch — keystone for lockstep multi-column SIMD | Already implied by our `ColumnStore::from_chunks` | — |
| **Per-row `type_tag`** | Formualizer ColumnChunk mod.rs:74-93 | (Defer: Phase 3+ heterogeneous types) | — | — |
| **`OnceCell` lazy null lanes** | Formualizer mod.rs:105-115 | (Defer: only matters when we add bool/text lanes) | — | — |
| **Sparse-chunks `FxHashMap<usize, ColumnChunk>`** | Formualizer mod.rs:265-268 | (Defer: revisit when spill outputs grow sparsely) | — | — |
| **Lazy chunk allocation** | Formualizer mod.rs:3425-3510 | Pattern: never densify on `ensure_row_capacity`; only allocate on write | (Phase 0: our `ColumnStore` auto-grows; revisit memory pressure later) | — |
| **`NumericChunk<'a>` borrowed view** | Formualizer `stripes.rs:3-21` | `pub struct NumericChunk<'a> { data: &'a [f64], validity: Option<ValidityMask> }` for SIMD kernels | Adapt to Quantbook's Value type | (Phase 0: defer to Week 4 ql-exec) |
| **Graph dump format** | (No precedent in any reference) | — | — | **Quantbook A4 assertion API**: `#[cfg(test)] fn stripe_to_dependents()`, `formula_to_range_deps()` typed accessors; assertions directly on `(StripeKey, HashSet<NodeId>)` shape. NOT a serialized form. |
| **Pratt parser** | IronCalc parser | (Phase B — deferred) | — | AI() reservation per CORR-06 |

---

## Plan corrections raised by this deep-read (CORR-21 through CORR-25)

**CORR-21** — *Stripe pattern is per-row/per-column unit indices, NOT prefix-tail.*

The Week 3 plan's W3-5 stripe-index commit was described as a "prefix-tail dedup structure (HyperFormula-style)." That mis-describes both references. Formualizer uses **`StripeKey { sheet_id, stripe_type: Row|Column|Block, index: u32 } → FxHashSet<VertexId>`** with a shape heuristic: `if enable_block && h>1 && w>1 → block; elif h>w → column; else row`. HyperFormula's prefix-tail is much narrower (one-step `end.row - 1` decrement, column-direction growth only) and lives in a separate per-sheet keyed `Map<string, RangeVertex>`, not a stripe index. **Adopt Formualizer's pattern as the W3-5 spec.** Phase 0 skips block stripes (simpler row-or-column heuristic); revisit in Week 4 if needed for the A5 falsifier.

**CORR-22** — *Aggregate caching deferred to Phase 4+.*

Formualizer does NOT cache range aggregates. HyperFormula does (per-function-name HashMap on RangeVertex, clear-all on dirty, prefix-tail combination). The HF pattern is GPLv3 but the algorithmic idea is freely reproducible. **HOWEVER** — Phase 0 doesn't need it. The 25M-cell `=A*2` hot path (OG-02) is per-cell SIMD over a region, not a range aggregate. Implementing aggregate caching now adds ~500 LOC of complexity for zero Phase 0 acceptance benefit. **Defer to Phase 4 when we integrate ql-functions properly.** Document this as a known follow-up.

**CORR-23** — *Scheduler uses iterative Tarjan SCC on dirty subset, NOT Kahn's algorithm.*

The Week 3 plan's W3-3 commit specified Kahn's algorithm. Both Formualizer (`engine/scheduler.rs:88-239`) and HyperFormula (`TopSort.ts:18-92`) use iterative Tarjan SCC. Reasons to prefer Tarjan:
1. Cycle detection in the same pass — Kahn requires a separate "did all dirty nodes emit?" check.
2. Returns `(sorted, cycled)` tuple — clearer API than Kahn + post-hoc cycle check.
3. Iterative version handles deep graphs without stack overflow.
4. Phase 0 minimum is "set CycleError on cycled vertices, evaluate rest" — Tarjan's output shape directly supports this.

**Adopt Tarjan SCC as the W3-3 spec.** Kahn-style layering for parallel evaluation is a Week 4+ optimization, not a Week 3 requirement.

**CORR-24** — *Graph dump is typed `#[cfg(test)]` accessors, NOT a serialized format.*

The Week 3 plan's W3-6 commit was described as "graph snapshot for A4 structural assertions + `.dot` debug export." Formualizer demonstrates the better pattern: tests assert directly on internal typed maps via `#[cfg(test)] pub(crate) fn stripe_to_dependents()` etc. (`engine/graph/range_deps.rs:25-34`). There is no precedent for a JSON or DOT whole-graph dump in any reference engine. **Adopt the typed-accessor pattern.** The `.dot` export via petgraph stays as an optional debug helper but is NOT what the A4 assertions consume. A4 assertions assert on `(StripeKey, HashSet<NodeId>)` shape.

**CORR-25** — *Two-overlay `user + computed` cascade deferred to OG-02 prep (Week 4).*

Phase 0 calcgraph integrates with our existing single-overlay `ColumnStore` (FIX-3's `iter_chunks`). The Formualizer `user.overlay → computed_overlay → base` cascade is the right model long-term, but adding `computed_overlay` to `ColumnStore` is a Week 4 task tied to formula write-back. Phase 0 W3-2 dirty propagation only READS from `iter_chunks` — it doesn't write formula outputs back. **Document as a Phase 4+ refactor; mark `SparseOverlay` as "user edits" today, leaving room for a `computed_overlay` sibling.**

---

## What's still on the question list (deferred reading)

These were lower-priority and didn't block Week 3:

- IronCalc parser (Section 5) — deferred until Phase B parser session.
- Formualizer Pearce-Kelly online toposort (`engine/topo/pk.rs`) — only relevant if Phase 4 needs online cycle prevention rather than detection.
- Formualizer rayon-parallel formula evaluation merge path (`eval.rs:5426-5650`) — perf opt for Week 4+.
- HyperFormula `AddressMapping` mutation path during row/col insert (`DenseStrategy.ts:81-115`) — only relevant when we implement insert_rows/delete_rows.
- `OverlayCascade::full_cover_dense_fragment` fast path — relevant if we hit cascade-merge perf wall.

---

## Files cloned

```
.references/
├── formualizer/      # github.com/PSU3D0/formualizer (MIT)
├── ironcalc/         # github.com/ironcalc/IronCalc (MIT or Apache)
└── hyperformula/     # github.com/handsontable/hyperformula (GPLv3 — patterns only)
```

All three gitignored via `quantbook-engine/.gitignore` (`.references/` entry). No code lift; algorithmic patterns documented above with provenance pointers.

---

**Bottom line for Week 3 implementation:**

The deep-read materially changes 5 commit specifications (CORR-21..CORR-25 above) but leaves the broader Week 3 plan intact. Net effect:
- W3-3: switch Kahn → Tarjan SCC.
- W3-5: switch prefix-tail → Formualizer-style per-row/col stripe map with shape heuristic.
- W3-6: switch JSON/DOT dump → typed `#[cfg(test)]` accessors.
- W3-1..W3-2, W3-4, W3-7..W3-9: unchanged.

The 5-day budget is unchanged; the corrected specs are simpler than the original (no prefix-tail recursion, no graph-dump serializer). HyperFormula's `bruteForce` toggle and aggregate caching, plus Formualizer's two-overlay cascade and per-row type tagging, are documented as Phase 4+ follow-ups.
