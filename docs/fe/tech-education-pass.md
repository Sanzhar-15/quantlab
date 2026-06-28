# Quantbook FE — Technical-Education Pass (reference-corpus study)

> **TE1 UPDATE (2026-06-28):** ENG-FUSION (2026-06-02) + TE1 (2026-06-28, engine `e3b052e2855`) have since shipped; the moat is **no longer engine-blocked** (forward plane wired — `publish_dataset`/`bind_range` live, unified `Binding`, napi readers). The "ENGINE-BLOCKED / `publish_dataset`/`bind_range` are stubs" statements below are stale. The reverse plane (`BoundFrame`/`qb.show`/edit-back) remains TE2.

> ⚠️ **STATUS: PRE-MEGAUDIT (2026-06-01) — SUPERSEDED on several points by the FE plan v2 (2026-06-02).**
> Build authority = `.plans/2026-06-01_quantbook-fe-engineering-plan.md` (v2, fusion-first) +
> `docs/fe/2026-06-02-fe-megaudit-SYNTHESIS.md`. This doc remains authoritative ONLY for the per-subsystem
> donor citations + the engine-gap table (§§1-4). **What changed and supersedes this doc:** (1) Renderer
> "WebGL/Pixi v2 swap" framing is WRONG — the owned @charts-plus WebGPU is **ARCHIVED** ("V6 Canvas2D-only,
> WebGPU removed"); GPU = v1.1+ NEW work. D-RENDERER = **own Canvas2D + a benchmarked bakeoff** (Codex-3
> gates), **NOTHING VENDORED** (Glide = pattern donor, no `@glideapps` dep). (2) Effort corrected:
> minimal grid **2-3wk** [FE-0b], Excel-grade renderer **8-12wk** [FE-2] (NOT "~3-6wk"). (3) The reactive
> moat is **ENGINE-BLOCKED** — `publish_dataset`/`bind_range` are stubs; a new **ENG-FUSION** engine
> mini-phase + a named gated **FE-1.5** (reactive fusion = the moat kill-gate) replace this doc's informal
> "FE-1.x" deferral. (4) Plan re-weighted **fusion-first, Excel-sufficient**: FE-4 Tier-3 dialogs cut to
> v1.5; four **FE-BEYOND** moves added to v1 (MCP server / quant-fn library first-class / multi-language
> dep-graph / thin lineage). (5) FE-1 adds a headless latency harness + a transport shootout.

**Date:** 2026-06-01. **Status:** complete for the wedge + renderer + UX clusters.
**Method:** the project's documented approach (v1-spec Part VI + front-matter) — *read the OSS reference
code deeply per subsystem, extract load-bearing patterns, re-implement in our own code; nothing vendored;
provenance under `docs/legal/` before ship.* This pass mirrors how the engine started (it cloned
formualizer/hyperformula/ironcalc, then built). The FE corpus was cloned 2026-06-01 into `.references/`
(locally gitignored): glide-data-grid, fortune-sheet, Luckysheet, univer, marimo, vscode-jupyter, ag-grid
(study-only), handsontable (pattern-only), x-spreadsheet. **Quadratic failed to clone** (repo URL/access
issue) — its WebGL pipeline below is reconstructed from univer/engine-render (the on-disk Canvas2D analog) +
Quadratic's engineering blog; re-clone `github.com/quadratichq/quadratic` to study its source directly.

All citations are real `file:line` from the clones. We **lift patterns, write our own** (study, don't copy).

---

## 1. The Python wedge (FE-1) — donors: Marimo (Apache-2.0) + vscode-jupyter (MIT)

### Reactivity (lift from Marimo)
- **AST-walk** = one `ast.NodeVisitor` subclass, `ScopedVisitor`, emitting `(defs, refs)` per code unit:
  `marimo/_ast/visitor.py:175` (ctor `on_def`/`on_ref` hooks `:180`); `visit_Assign:813`, `visit_FunctionDef:602`,
  `visit_ClassDef:574`, `visit_Import:1032`/`visit_ImportFrom:1049`, `visit_Name:924`; `_define:384`. Public
  entry `compile_cell` (`marimo/_ast/compiler.py:251`) = the `(code)→(defs,refs,imports)` function to lift.
- **Fingerprint** (no content diff): after a run, read just-defined names from globals + cheap descriptor:
  `_broadcast_variables` (`marimo/_runtime/runner/hooks_post_execution.py:121`), `create_variable_value`
  (`marimo/_messaging/variables.py:214`, `type().__name__` + truncated repr); tabular duck-type probe
  `get_datasets_from_variables` (`marimo/_data/get_datasets.py:24,40`).
- **What we do DIFFERENTLY:** Marimo *owns* a reactive cell DAG (`dataflow/graph.py:32`) and re-runs
  descendants — **we don't.** We embed a *general* ipykernel; the Rust engine is the recompute source of
  truth. We lift only the single-cell `(defs,refs)` extraction + fingerprint, hung off IPython's
  `post_run_cell`, and **explicit `qb.publish`/`qb.bind` is authoritative** — the AST heuristic is an advisory
  nudge ("you made a dataframe and didn't publish it"), never a silent mutation.
- **Bonus:** synthetic filename + linecache for `quantbook://…/C7.py`: `compiler.py:69,77,131` (`get_filename`,
  `cache`, `cell_id_from_filename`).

### Kernel embedding + debug (lift from vscode-jupyter — the RAW/ZMQ path)
- **Process lifecycle:** `KernelProcess` (`src/kernels/raw/launcher/kernelProcess.node.ts:88`); interrupt =
  SIGINT-to-group vs control-channel message (`:145`); serialized interrupt/restart promises
  (`src/kernels/kernel.ts:283`).
- **ZMQ 5-channel wiring + HMAC framing:** `RawSocket` (`src/kernels/raw/session/rawSocket.node.ts:27,154,219,256`),
  shell/control/stdin Dealers + iopub Subscriber; `wireProtocol.encode/decode(key,scheme)`.
- **debugpy = DAP tunneled over the control channel** + a cell↔tempfile source map (`dumpCell`):
  `kernelDebugAdapterBase.ts:55,310,358`, `kernelDebugAdapter.ts:19,26`. This is exactly our
  `quantbook://…/C7.py` debug story.
- **Rich display** = standard iopub `display_data`/`execute_result` (`src/kernels/execution/`).
- **Simplify hard:** we need ONE kernel bound to ONE workbook — drop kernel discovery, the server path, web
  variant, ipywidgets.

### Reuse win + net-new
- **Reuse qviz `daemon-lifecycle.ts:163` to supervise the kernel** — it's transport-agnostic process
  supervision (spawn/ready/crash/respawn-with-backoff/staleness-generation/dispose; `:222,371,396,463,494`),
  carrying megaudit fixes. Generalize its `ManagedClient` coupling; build a new ZMQ `KernelClient` (the only
  net-new transport). The qviz daemon's stdio-frame transport (`daemon-client.ts:10,503`) is NOT reusable
  (kernel = ZMQ).
- **`quantbook-py` today = UDF worker only** (`__init__.py:21` = just `register_formula_function`). Net-new
  Python: `qb.show`/`BoundFrame`/`publish`/`bind` + the `post_run_cell` hook. Reuse the "repoint fd 1 so user
  print can't corrupt the protocol" discipline (`worker.py:3-7`).

### FE-1 writeback — use the SHIPPED `write_range`, do NOT flip stubs
> **STALE (TE1, 2026-06-28):** `publish_dataset`/`bind_range` are no longer `not_implemented` stubs — they shipped in ENG-FUSION (2026-06-02) and were wired into the unified var↔cell `Binding` in TE1 (forward plane).
- `BoundFrame.tx.commit()` → engine `write_range` (`ql-exec/src/session.rs:3168`, one atomic BatchCommit;
  HTTP `ql-service/src/router.rs:238`). `qb.show(df)` initial materialize → `materialize_query` (`:3258`,
  `router.rs:247`) or a thin literal-block wrapper over `write_range`. **`publish_dataset`/`bind_range` are
  `not_implemented` stubs (`session.rs:3245,3254`) — FE-1 does NOT need them**; flipping them is the later
  first-class `publish`/`bind` work.
- **Thinnest slice:** `KernelClient` + reused `KernelLifecycle` + `qb.show`(df→Arrow→`write_range`) + sheet
  view + `BoundFrame.edit().commit()`(rect→`write_range`). Defer debugpy + the reactivity heuristic to FE-1.x.
- **Go/no-go (CORR-18):** `BoundFrame.commit()` < 100 ms median / 1000 edits; pandas mutation ≥ 95%. Below
  either → v1 collapses to one-way `qb.show()` — and that is itself the Month-6 kill-gate signal.

---

## 2. The grid renderer (FE-2) — donors: Glide Data Grid (MIT, liftable) + Quadratic (source-available, pattern-only) + univer/engine-render (Apache-2.0, the on-disk Canvas2D analog)

### Glide Data Grid — the liftable Canvas2D React grid (the v1 path)
- **DataEditor API (pull-based):** `getCellContent(cell)→GridCell` (`packages/core/src/data-editor/data-editor.tsx:546`);
  edits `onCellEdited:213`/`onCellsEdited:217`; fill `onFillPattern:252`; paste `onPaste:637`; selection model
  `GridSelection` (`data-grid-types.ts:16`), `onGridSelectionChange:510`; **viewport signal**
  `onVisibleRegionChanged:521` (= our `subscribeViewport`); pluggable editor `provideEditor:164` (= host Monaco).
- **Incremental redraw (the perf trick):** blit-last-frame + double-buffer + redraw only the newly-exposed
  strip (`internal/data-grid/render/data-grid-render.blit.ts:21`); damage-based partial repaint
  (`data-grid-render.ts:36-115`); visible-only walk (`data-grid-render.walk.ts:20`).
- **Huge-sheet scroll:** segmented-padder beats the browser div-height cap (`infinite-scroller.tsx:73`,
  `MAX_PADDER_SEGMENT_HEIGHT=5_000_000`) — fixes exactly the wall the current DOM stopgap hits.
- **Edit overlay = DOM portal over canvas** (`data-grid-overlay-editor.tsx:234`) — the v1-spec "DOM overlay"
  model; host a Monaco editor here.
- Caveat: glide is column-oriented (`columns: GridColumn[]`); an A1 infinite-blank sheet needs an adapter
  synthesizing columns A..Z…

### Quadratic WebGL pipeline (pattern-only; the v2 swap)
- 3-context topology (Rust/WASM core + TS render worker + Pixi main), zero-copy Transferable buffers, viewport
  tracked via SharedArrayBuffer. **Spatial-hash tiling** (15col×30row buckets, viewport-cull, LRU ~500 MB) →
  10–50 draw calls/frame over millions of cells. Four shaders (triangle/line/text/sprite). **MSDF glyph atlas**
  for the whole zoom range = the highest-effort, highest-risk subsystem (font fallback/CJK + custom shader;
  the #10463 risk). On-disk analog (cite-able): univer `engine-render/src/viewport.ts:230,838,874` (cache
  canvas + diff-blit) + `components/sheets/spreadsheet.ts:134,303` (layered extension draw + incremental
  cache). Realistic WebGL build ≈ **3–5 eng-months, MSDF the schedule driver.**

### D1 RESOLVED — build the Glide-pattern Canvas2D grid for v1
~3–6 wk, behind a renderer interface that keeps the WebGL backend as a **v2 swap**. The as-built DOM "grid"
is a 3-col Row|Col|Value debug list (`cellGridHtml.ts:106`), not a real grid. WebGL is overkill for v1 data
sizes (≤~1M populated cells); only *headline continuous-zoom over 10M+ distinct cells* would force it.

### The engine ALREADY speaks the whole viewport-first protocol (zero engine work for the Canvas2D path)
| Spec verb | Shipped napi method (`ql-bindings-node/src/lib.rs`) |
|---|---|
| viewport batch | `queryRange` `:6021` → columnar `RangeResultJson` |
| sparse patches | `snapshotDelta` `:6910` (changed/removed + version token) |
| invalidation/diagnostics | `pollEvents` `:6867` (+ `full_resync_required`/`dropped` reseed) |
| commit edits | `setValue` `:5702` / `setFormula` `:5728` / `setFormat` `:6060` |
| paste/fill | `writeRange` `:6532` (one BatchCommit) |
| materialize | `materializeQuery` `:6634` |
| undo/redo/save/recalc/snapshot | `undo`/`redo`/`save`/`recalcDirty`/`snapshot` |
The **only** additive engine task is an Arrow/binary encoder — and **only if** WebGL (option c) is later
chosen (the JSON DTOs are fine for Canvas2D). `pollEvents` is pull (fine in-process; wrap as a subscription
for a remote `ql-service` client).

---

## 3. Spreadsheet UX (FE-3 formula bar + FE-4 breadth) — donors: FortuneSheet + Luckysheet + x-spreadsheet (all MIT, liftable)

### ⚠️ Load-bearing finding: the engine has NO visual-style model
Engine cell snapshot = `{row, col, value, formula, format(number-format id only), rendered}`
(`crates/ql-session/src/dto.rs:161-178`). **No font/bold/italic/color/border/alignment/wrap/rotation, no
row-height/col-width, no merge, no comments, no conditional-formatting, no data-validation.** The engine
explicitly DROPS CF/DV/merge on import as warnings (`ql-exec/src/session.rs:1309,7298`). So **all visual
formatting beyond number-format must be FE-owned (a parallel style store the FE persists), OR the engine
grows a style model (large).** → new decision **D5** (below). For the wedge, FE-owned is the pragmatic v1.

### Formula bar (FE-3): keep FortuneSheet semantics, replace mechanism with Monaco
FortuneSheet's bar is a contentEditable with a hand-rolled char-scanner colorizer
(`packages/core/src/modules/formula.ts:1910-2133`), range-pick (`:1535,1873,2972`), signature help
(`react/src/components/SheetOverlay/FormulaHint/index.tsx`), autocomplete (`FormulaSearch/`). **Replace all of
it with Monaco providers** (Monarch tokenizer for colored funcs/strings/parens/refs; `SignatureHelpProvider`
fed by engine `listFunctions`; `CompletionItemProvider`; decorations for colored ranges; markers from engine
`validateFormula`). KEEP the *semantics*: range-pick = splice A1 ref at cursor on grid-click. In-cell editor +
formula bar = twin Monaco instances over one shared edit state machine.

### Selection + keyboard (adapt x-spreadsheet structure + FortuneSheet coverage)
- Selection value type: x-spreadsheet `CellRange{sri,sci,eri,eci}` with set algebra
  (`x-spreadsheet/src/core/cell_range.js:3-218`) — cleaner than FortuneSheet's geometry-entangled
  `luckysheet_select_save` (`fortune-sheet/.../selection.ts:101`). Keep logical ranges pure; project pixels
  at render time; array-of-ranges for multi-select.
- Keyboard map: FortuneSheet `keyboard.ts:676-951` (global) + `:314-601` (Ctrl chords) is the most complete
  Excel-fidelity reference; x-spreadsheet `component/sheet.js:739-883` is the cleaner switch structure to
  adopt. Full chord set enumerated in the FE plan's FE-4. **Do NOT copy** FortuneSheet's regex formula-ref
  adjustment on Ctrl+D/R (`keyboard.ts:535`) — delegate ref-translation to the engine (it already rewrites
  refs for table/sheet rename).

### FE-4 prioritized sub-sequence (grounded in the wedge: a quant interrogating + lightly editing a qb.show'd sheet)
- **Tier 0 (table stakes):** selection model; Excel keyboard map; in-cell+formula-bar Monaco twins; copy/cut/
  paste (TSV+HTML, paste via `writeRange`/`batch`); undo/redo (engine).
- **Tier 1 (high value, engine-backed):** Monaco formula intelligence (tokens/diagnostics via
  `validateFormula`/signature via `listFunctions`/range-pick); number formatting (`setFormat`/`registerFormat`
  — the one styling kind the engine owns); find/replace (FE over snapshot); interactive name box + named-range
  manager (`setName`); fill handle (series FE; ref-adjust via engine); structured-table UI (`createTable`/
  `renameColumn`/`resizeTable`/`dropTable` — full engine CRUD; high value for tabular Python output).
- **Tier 2 (FE-owned style store, can lag):** cell styling (bold/color/border/align) over a FE style store;
  row/col sizing; insert/delete/hide rows&cols; sort/filter; context menus; freeze/split.
- **Tier 3 (defer v1.5/v2):** CF dialog (engine drops CF); DV dialog (engine drops DV); comments; hyperlinks/
  images/text-to-columns/screenshot; Luckysheet-only (pivot, sparkline, print, xlsx export).

### Full UX feature inventory (the FE-4 scope, enumerated)
FortuneSheet's declarative lists are the cleanest inventory: toolbar + 4 context menus +
filter menu at `fortune-sheet/packages/core/src/settings.ts:179-280`. Categories (each with cited donor
impl in the source notes): A. cell editing; B. selection/navigation; C. number-format + styling; D.
structure (rows/cols/sheets/merge/freeze); E. fill handle + smart fill; F. clipboard; G. find/replace; H.
sort/filter/data-tools; I. dialogs (CF/DV/comments/hyperlinks/images/charts); J. history/context-menus/
protection. (The Tier mapping above is the build order.)

---

## 4. Consolidated engine-side gaps the FE will hit (file for an engine mini-phase)

From the renderer + UX passes. None block the FE-1 wedge or the Canvas2D grid; they bite the Phase-7 UX.

| Gap | Status | Disposition |
|---|---|---|
| Visual cell style (font/bold/color/border/align/wrap) | engine has NO style field | **D5** — FE-owned style store for v1 (pragmatic), or engine style model (large). Decide. |
| Row height / column width | no engine method | FE view-state for v1; engine model only if needed for persistence/xlsx round-trip |
| Merged cells | dropped on import (`session.rs:1309`) | FE overlay v1; engine merge semantics (formula/spill) only if needed later |
| Conditional formatting (write/eval) | dropped on import | FE-owned eval + style store (v1.5+) |
| Data validation | dropped on import | FE-owned (v1.5+) |
| Comments | no field | FE-owned (v1.5+) |
| Arrow/binary viewport encoder | JSON DTOs only | additive engine task **only if** WebGL renderer chosen (v2) |
| `toggleRefAnchors` (F4) / `translateFormula(dRow,dCol)` (fill) | not exposed | nice-to-have engine helpers (engine already rewrites refs for rename) |

---

## 5. Resolved decisions (feeding the FE plan)
- **D1 renderer = Glide-pattern Canvas2D grid for v1**, WebGL backend as a v2 swap behind an interface.
- **D2 wedge runtime = reuse qviz `daemon-lifecycle` to supervise a new ZMQ `KernelClient`;** explicit-publish
  reactivity first, Marimo `post_run_cell` heuristic + debugpy as FE-1.x.
- **D3 SQL cell** (unchanged) = reconcile to engine `materialize_query` (DataFusion); `=DUCKDB()` → v1.5.
- **D5 (NEW) visual styling = FE-owned style store for v1** (the engine has no style model); revisit an engine
  style model only if persistence/xlsx-round-trip demands it (xlsx export is v2 anyway).

## 6. License posture (v1-spec Part X)
Liftable (MIT/Apache): Glide, FortuneSheet/Luckysheet, x-spreadsheet, univer, Marimo, vscode-jupyter.
Pattern-only / review-terms: **Quadratic** (source-available), AG Grid Enterprise (commercial), Handsontable
(non-commercial), LibreOffice (MPL+LGPL), Gnumeric (GPLv2+). We re-implement in our own code regardless;
provenance under `docs/legal/` before ship (CORR-10).

## 7. Follow-ups
- Re-clone `github.com/quadratichq/quadratic` (failed twice in the batch; URL/access) to study its WebGL
  source directly if/when the WebGL backend is scheduled.
- Notion/Airtable/Grist cell-type-system patterns are conceptual (not cloned) — study at the rich-table-types
  stage.
