# Quantbook FE Plan — "Beyond Excel/Sheets" Megaudit — SYNTHESIS

> **TE1 UPDATE (2026-06-28):** ENG-FUSION (2026-06-02) + TE1 (2026-06-28, engine `e3b052e2855`) have since shipped; the moat is **no longer engine-blocked** (forward plane wired). The "ENGINE-BLOCK / `publish_dataset`/`bind_range` = `not_implemented` stubs" findings below (T1, the ENG-FUSION recommendation, the verified-HIGHs) are stale — those primitives are live and wired into a unified var↔cell `Binding`. The reverse plane (`BoundFrame`/`qb.show`/edit-back) remains TE2.

**Date:** 2026-06-02. **Target:** `.plans/2026-06-01_quantbook-fe-engineering-plan.md`.
**Bar audited against:** the operator's stated ambition — *something more optimal, advanced, efficient,
and effective than Excel and Google Sheets*, NOT a clone.
**Method:** 7 independent lanes across 3 model families + Opus synthesis. 2 Codex (read-only, high
reasoning): C1 architecture/perf-ceiling, C2 differentiation (adversarial). 5 focused Sonnet: S-A wedge
moat, S-B completeness critic, S-C competitive positioning, S-D sequencing/effort, S-E engine capability.
Every HIGH below independently verified at source before synthesis.

## VERDICT: PARTIAL — strong foundation, does NOT yet clear the "beyond Excel/Sheets" bar.

All 7 lanes converged (6-for-6 on the central finding before C1; C1 then confirmed it on architecture):
**the plan as written is a path to an excellent Excel-clone-plus-Python-wedge, but the one
category-defining capability (reactive Python↔grid fusion) is deferred and partly engine-blocked, while
v1 effort is dominated by Excel parity and the architecture preserves Excel-class ceilings.** Codex-2:
*"the wedge could clear the bar, but the plan buries the only category-defining capability under a large
Excel-parity rebuild and defers too many fusion acid tests."* Codex-1: *"not yet an optimal
'beat Excel/Sheets' architecture; it preserves several Excel-class ceilings and defers the advanced path
without a benchmarked falsifier."*

---

## The 5 convergent themes (deduped across lanes)

### T1 — The moat is DEFERRED and partly ENGINE-BLOCKED (the single most important finding)
- The differentiator is reactive Python↔grid fusion. The plan defers acid test #1 (cell formula
  referencing a Python var recalcs on change), #4 (debug-from-cell), and #6 (file-watch → dirty cells)
  to "FE-1.x" — an unnamed bucket with no gate. FE-1 validates only the thinnest one-shot BoundFrame
  loop. **[S-A H1/H2/H3, C2-A2]**
- **VERIFIED ENGINE-BLOCK:** the reactive-push primitives `publish_dataset` + `bind_range` are
  `not_implemented_in_v1_core` stubs (`ql-exec/src/session.rs:3245,3254,3550`). v1 can do one-shot
  `write_range` push + pull `bound.refresh()` — NOT reactive binding. The moat cannot be built FE-only.
  **[S-E H-1 — verified at source]**
- Wedge as scoped delivers ~2 of 6 fusion acid tests cleanly (#3 UDFs, #5 diffable storage), one
  partially (#2 writeback), defers/omits the 3 most novel (#1, #4, #6). **[S-A]**

### T2 — v1 effort is dominated by PARITY, not surpassing
- FE-4 (ribbon, CF/DV dialogs, keyboard fidelity, freeze/split, find/replace) is catching-up to Excel,
  is the largest + least-differentiated increment ("weeks–months"), and risks fighting on the wrong
  axis while competitors win on collab/AI/scale. **[C2-A1, C2-A4, S-C §5]**
- "Almost identical to Excel" + "more advanced than Excel" are in tension — uncanny-valley risk (90%
  Excel-identical but subtly different breaks muscle memory). **[C2-A7]**

### T3 — The architecture preserves Excel-class CEILINGS (verified)
- **Scale = Excel-parity, not beyond:** engine `MAX_ROW=1,048,575` / `MAX_COLUMN=16,383` (exactly
  Excel); 1M-cell caps on `query_range`/`write_range`/SQL-input; all data in-memory; no out-of-core,
  no streaming. "Billions of rows" is architecturally impossible in v1. **[C1-A2/A9, S-E §2 — verified]**
- **Transport sub-optimal:** the wedge chains Arrow IPC → ZMQ/ipykernel → JS → napi → `Vec<Vec<CellValue>>`
  → per-cell ops. The spec wanted PyO3 zero-copy Arrow; pyo3 + `ql-service` already exist. `<100ms/1000
  edits` is UNPROVEN until measured. **[C1-A3]**
- **GPU path is fictional:** the plan's "owned @charts-plus WebGPU v2 swap" is overstated — the Terminal's
  `chart-render-webgpu` is **archived**; `renderer-factory.ts` = "V6: Canvas2D-only, WebGPU removed."
  The owners abandoned GPU for Canvas2D (mild validation of Canvas2D-for-grid; but no near-ready owned GPU
  backend exists). Canvas2D was chosen without a benchmarked scale falsifier. **[C1-A1/A8 — verified]**
- **Viewport wire (JSON DTO) + per-cell style store** are scale ceilings for large prefetch/GPU; style
  store `{cellKey→styleProps}` is non-scalable (styles want range-compression). **[C1-A4/A5]**

### T4 — The "BEYOND" capabilities are mostly deferred/absent (32 enumerated)
S-B enumerated 32 distinct "beyond Excel" capabilities. Top-5 most under-invested:
1. **Agentic / NL→sheet AI** (the plan's AI is 2024-era inline-complete + chat; `=AI()` is v2; no MCP
   server — Quadratic ships MCP so agents read/write the live sheet). **[S-B#6, S-C borrow-HIGH]**
2. **User-facing data lineage / provenance** ("why is this cell this value", full dep tracing) — the 6.5
   provenance index exists but is session-local + SQL-only; not generalized or surfaced. **[S-B#7, S-E M-3]**
3. **Quant function library as a first-class, marketed feature** (`=BACKTEST`/`=SHARPE`/`=MAX_DRAWDOWN`/
   TA-Lib/QuantLib) — Quadratic/Excel have no analog; buried as generic UDFs. **[S-B#18, S-C]**
4. **Unified multi-language dependency graph** (Python + SQL + formulas as ONE reactive graph) — the
   actual "fusion" headline; not surfaced as a concept. **[S-B#22]**
5. **Semantic git-diff + workbook testing** (`qb diff` / `qb test` on the `.qbook` format) — diffable
   storage exists but no tooling/UX. **[S-B#8+#23]**
- Also notable: real-time collab is v1.5 (Quadratic/Hex/Deepnote ship it in v1; the Loro CRDT is built
  but the transport is unwired); column types/schemas absent; live connectors unwired. **[S-B, S-E]**

### T5 — Execution UNDER-SCOPES the hard greenfield (verified)
- **FE-0 ~1wk is really ~4-5wk:** it bundles mechanical session-wiring (⚙️, ~1wk) with building an own
  canvas renderer (✋, multi-week) — split them. **[S-D F1, C1-A6]**
- **MISSING prerequisite (verified):** the cellGrid webview is inline-HTML; a canvas renderer is a real TS
  module needing a NEW esbuild webview bundle entry + inline-HTML→bundled migration + CSP change — absent
  from the plan, and the esbuild config is shared with the Terminal (build-entanglement risk). **[S-D F3/F10 — verified: no sheets esbuild entry]**
- **No headless latency harness:** the CORR-18 kill-gate can't fail-cheap without a headless harness run
  BEFORE the full wedge; not captured. **[S-D F5, C1-A3]**
- **Arrow bridge under-specified:** `quantbook-py` has no Arrow dep; Node has no Arrow reader; dtype/NULL/
  datetime mapping + cap handling undefined — a week of greenfield. **[S-D F4]**
- **Mis-tagged Cockpit lanes:** the Excel keyboard map (FE-4 Tier 0) and the error surface (FE-5 C06) are
  tagged ⚙️ but are correctness-hard (state-machine / diagnostics-correlation) — retag ✋. **[S-D F8/F9]**
- **Missing risks:** cdylib/napi version-load mismatch (IDE a full engine-phase behind; `loader.ts` does
  `require()` with no `typeof engine.Session==='function'` guard); zeromq.js native-module platform matrix;
  `parseCellRawInput` is numeric-only and breaks the wedge demo on string columns. **[S-D F6/F13/F14]**
- engine "done" overstated: SIMD graph dispatch is observability-only; the 25M-cell recalc advantage is
  unverified at the session level. **[C1-A7]**

---

## Competitive whitespace (S-C) — it IS defensible, if not diluted
Defensible whitespace = the intersection no competitor occupies: **IDE-native (VS Code) + bidirectional
Python binding (BoundFrame) + local-first/data-never-leaves + quant depth.** Quadratic (closest analog:
Rust+WASM+Python+SQL WebGL spreadsheet) has one-way Python→cells, is cloud-collab/now-closed-source, and
has no IDE host, no debugger, no bidirectional binding, no quant library — but it SHIPS MCP + collab in
v1. Microsoft Python-in-Excel is cloud/quota/one-way. The whitespace is real; the risk is spending v1 on
Excel-UX parity (where nobody is winning) instead of the four whitespace axes.

---

## RECOMMENDED RE-WEIGHTING: "fusion-first, Excel-sufficient"
The product is a **live Python↔sheet reactive dependency workspace**; Excel UX is the *substrate*
(sufficient for quant models), not the *goal*. Concretely:
1. **Elevate the moat into v1.** Move acid #1 (reactive invalidation), #4 (debug-from-cell), #6
   (file-watch reactivity) from FE-1.x into a NAMED, gated **FE-1.5** that lands BEFORE FE-4 UX breadth.
2. **Add an engine prerequisite mini-phase (ENG-FUSION):** implement `publish_dataset` + `bind_range`
   (the moat is engine-blocked today). Plus the kernel→engine dirty-notify path for reactivity.
3. **Cut Excel-parity gold-plating:** FE-4 Tier 3 (CF/DV dialogs, comments, hyperlinks/images,
   text-to-columns) → v1.5 with an explicit go/no-go gate. "Excel-familiar basics + deliberately superior
   quant/Python workflow" — diverge where Quantbook is better; don't chase pixel-fidelity.
4. **Add the high-leverage BEYOND moves:** MCP server over the 53-method surface (cheap; AI agents
   read/write the live sheet); data-lineage UX (generalize the 6.5 provenance + surface it); the quant
   function library as a marketed first-class feature; the unified multi-language dependency graph as the
   headline concept; semantic `qb diff`/`qb test` tooling.
5. **Scale honesty + architecture de-risking:** state v1 = Excel-parity scale (not "billions"); add a
   renderer bakeoff with scale gates before locking Canvas2D; add a transport shootout (ZMQ vs PyO3
   zero-copy vs ql-service) with a real benchmarked CORR-18; correct the WebGPU-fallback claim (archived);
   design a binary tile protocol + range-compressed style model earlier; sketch an out-of-core data-plane
   for v1.1 (the only path to genuinely beat Excel on scale).
6. **Fix execution:** split FE-0 (0a wiring ⚙️ / 0b renderer ✋ multi-week); add the webview-bundling
   migration as an explicit prerequisite; add the headless latency harness as FE-1 task #0; spec the Arrow
   bridge; retag the mis-tagged Cockpit lanes; add the missing risks (cdylib guard, zeromq matrix,
   parseCellRawInput text fix, esbuild build-isolation).

## Open operator decisions (these change the plan's shape)
- **D-AMBITION:** re-weight fusion-first + cut FE-4 parity to v1.5? (recommend YES)
- **D-ENG-FUSION:** add the engine mini-phase to implement `publish_dataset`/`bind_range` now? (recommend
  YES — the moat is engine-blocked)
- **D-SCALE:** accept Excel-parity scale for v1 + plan out-of-core data-plane for v1.1, OR attempt
  beyond-Excel scale (GPU + out-of-core) in v1? (recommend Excel-parity v1, data-plane v1.1)
- **D-RENDERER:** keep own-Canvas2D + a benchmarked bakeoff/falsifier, OR commit GPU-first now? (recommend
  Canvas2D + bakeoff; the owners abandoned GPU)

## HIGHs verified at source (this synthesis)
- `publish_dataset`/`bind_range` = `not_implemented_in_v1_core` (session.rs:3245/3254/3550) — moat engine-blocked.
- Terminal `chart-render-webgpu` archived; renderer-factory.ts "V6 Canvas2D-only, WebGPU removed" — GPU fallback fictional.
- No `sheets`/`cellGrid` esbuild webview entry — bundling migration is a missing prerequisite.
- `MAX_ROW=1,048,575` / `MAX_COLUMN=16,383` (ql-types/address.rs) — scale is Excel-parity, not beyond.

## Lane raw outputs
Codex: `/tmp/feaudit/codex-{1,2}.out` (untracked). Sonnet lanes captured in the megaudit transcript.
