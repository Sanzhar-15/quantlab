# Delta Charting Engine V3 Specification
## WebGPU‑first • capability‑tiered • tile‑cached • ultra‑smooth financial charting UX

**Status:** Proposed V3 (implementation‑ready)  
**Scope:** Rendering UX architecture + interaction engine + data→pixels foundations  
**Primary objective:** Build charting that feels *noticeably* smoother and higher-quality than TradingView, while remaining production‑robust across real browser/device variability.

---

## Table of contents
- [0. Executive summary](#0-executive-summary)
- [1. Non‑negotiable quality contracts](#1-non-negotiable-quality-contracts)
- [2. Platform reality and capability tiers](#2-platform-reality-and-capability-tiers)
- [3. Deployment modes and transport layer](#3-deployment-modes-and-transport-layer)
- [4. System architecture](#4-system-architecture)
- [5. Rendering architecture](#5-rendering-architecture)
- [6. Text architecture](#6-text-architecture)
- [7. Input and interaction architecture](#7-input-and-interaction-architecture)
- [8. Picking and hit‑testing architecture](#8-picking-and-hit-testing-architecture)
- [9. Data‑to‑pixels pipeline](#9-data-to-pixels-pipeline)
- [10. Shader toolchain and backend strategy](#10-shader-toolchain-and-backend-strategy)
- [11. Reliability and recovery](#11-reliability-and-recovery)
- [12. Observability and regression prevention](#12-observability-and-regression-prevention)
- [13. Engineering plan and milestones](#13-engineering-plan-and-milestones)
- [Appendix A: Interfaces](#appendix-a-interfaces)
- [Appendix B: Tier selection algorithm](#appendix-b-tier-selection-algorithm)
- [Appendix C: Acceptance benchmarks](#appendix-c-acceptance-benchmarks)

---

## 0. Executive summary

Delta Charting Engine V3 treats charting as a **real‑time graphics engine** (similar mental model to Figma or map engines), optimized for:

- **Perceived smoothness** (frame pacing, low input‑to‑photon latency, interaction isolation)
- **Visual quality** (crispness at any DPR/zoom, stable text, consistent strokes, no shimmer)
- **Scale** (large visible history, dense overlays, streaming updates)
- **Robustness** (device loss recovery, error handling, deterministic fallbacks)
- **Maintainability** (shared core, capability tiers, unified shader source strategy)

The key differentiator versus TradingView-style Canvas2D layering is **GPU tile caching + instant reprojection**: “move content immediately, refine progressively.”

**Important V3 stance:** *WebGPU-first does not mean WebGPU-only.* Production reliability requires capability tiers and fallbacks, without compromising the premium path.

---

## 1. Non‑negotiable quality contracts

These are architectural invariants. If any can be broken, the system will eventually “feel bad” at scale.

### 1.1 Crosshair contract: never jank
- Crosshair + tooltip updates must remain responsive during:
  - background tile rebuilds,
  - indicator recompute,
  - streaming tick bursts,
  - heavy overlays,
  - text atlas updates.
- Tooltip values must be computable from CPU-side data buffers (no GPU readback dependency).
- Crosshair is always rendered as a **cheap isolated pass/layer**.

### 1.2 Immediate response contract (pan/zoom)
- **Pan:** must show reprojected content in the same frame (even if stale), then refine.
- **Zoom:** must show a correct low-LOD silhouette immediately, then refine progressively.

### 1.3 No hover-time GPU readback contract
- No GPU readback on pointer move/hover.
- GPU picking (ID buffer) is **click/tap only** and asynchronous (tolerate 1‑frame delay).

### 1.4 Pixel‑perfect crispness contract
- All snap decisions occur in **physical pixel space** (device pixels), not CSS pixels.
- Must remain crisp at browser zoom changes and mixed‑DPR monitors.

### 1.5 Resilience contract
- Must recover from GPU device loss and avoid “blank chart” failure modes.
- Must downgrade tiers automatically on repeated instability.

---

## 2. Platform reality and capability tiers

Browser/device variability is real (especially around worker rendering + OffscreenCanvas contexts). V3 uses capability tiers that preserve the premium experience whenever possible, without brittle assumptions.

### 2.1 Tiers

#### Tier A — WebGPU Worker Renderer (Best)
**Requirements**
- WebGPU available
- OffscreenCanvas transferable to worker and worker can acquire rendering context
- Optional: cross-origin isolated for SAB turbo transport

**Features**
- Full tile cache + reprojection
- MSDF numeric/Latin text
- Progressive refinement (stage 0/1/2)
- Optional WebGPU compute for parallel-friendly tasks

#### Tier B — WebGPU Main-thread Renderer (Premium Compatible)
**Purpose**
- Enables WebGPU premium rendering even when worker WebGPU canvas paths are unavailable/restricted.

**Constraints**
- Strict main-thread budgeter to avoid long tasks
- Workers still handle: data ingestion, LOD/envelopes, indicator CPU/WASM, shaping, heavy parsing

#### Tier C — WebGL2 Safety Renderer (Compatibility)
**Goal**
- Keep the chart usable when WebGPU init fails or repeated device loss occurs.

**Features**
- Reduced fidelity (quality knobs), but preserves the Crosshair and Immediate Response contracts.

#### Tier D — Canvas2D Safe Mode (Last resort)
**Goal**
- Always render something usable everywhere.
- Use layered Canvas2D redraw minimization patterns (TradingView-style separation of main layer vs crosshair layer).

### 2.2 Remote allowlist/blocklist guardrail
In addition to runtime feature detection:
- add a server-updatable ruleset to force downgrade for known-bad device cohorts
- roll out new tiers gradually with kill switches

---

## 3. Deployment modes and transport layer

SharedArrayBuffer is a turbo feature with real deployment requirements. V3 mandates a transport abstraction so the engine works in embeds and non-isolated contexts.

### 3.1 Transport abstraction (mandatory)

#### TransportSAB (Turbo)
- Used only when `crossOriginIsolated === true`
- Atomic ring buffers for:
  - InputState (high frequency)
  - Viewport/CameraState
  - Dirty flags
  - Optional tick append ring

#### TransportMessage (Compat/Embed)
- Always supported
- `postMessage` with transferable `ArrayBuffer`
- Input coalescing at the source to reduce message frequency

### 3.2 Deployment modes
- **App Turbo:** COOP/COEP enabled, SAB available.
- **App Compat:** no COOP/COEP required; message transport.
- **Embed:** assume no header control; message transport; conservative tier selection.

---

## 4. System architecture

### 4.1 Logical runtime layout

```text
┌────────────────────────────────────────────────────────────┐
│ Main Thread (UI + Input)                                   │
│ - DOM/React UI                                              │
│ - Pointer/touch/keyboard capture                            │
│ - Writes InputState + ViewportState → Transport             │
└───────────────┬────────────────────────────────────────────┘
                │ (SAB rings OR postMessage transferables)
┌───────────────▼────────────────────────────────────────────┐
│ Render Runtime                                              │
│ Tier A: Render Worker owns GPU                              │
│ Tier B: Main thread owns GPU                                │
│ - Scene graph + Render graph                                │
│ - Tile cache + Damage tracking                              │
│ - GPU Resource manager                                      │
│ - Text system (MSDF + fallback compositing)                 │
│ - Scheduler (interaction-first budgets)                     │
└───────────────┬────────────────────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────────┐
│ Data Runtime (Worker)                                       │
│ - Data ingest + parse                                       │
│ - Columnar store + chunking                                 │
│ - LOD pyramid + envelope building                           │
│ - Indicator compute (CPU/WASM baseline)                     │
└────────────────────────────────────────────────────────────┘
```

### 4.2 Recommended packages/modules
- `@delta/chart-core`: math, scales, transforms, formatting, snapping rules
- `@delta/chart-data`: ingestion, columnar store, LOD pyramid, streaming
- `@delta/chart-render`: renderer interface, scene graph, render graph, scheduler, damage tracking
- `@delta/chart-webgpu`: Tier A/B backend (pipelines, passes, resource manager)
- `@delta/chart-webgl2`: Tier C backend
- `@delta/chart-canvas2d`: Tier D backend
- `@delta/chart-text`: MSDF pipeline + Canvas2D/DOM fallback
- `@delta/chart-observability`: metrics + tracing + perf harness
- `@delta/chart-ui`: UI integration layer

---

## 5. Rendering architecture

### 5.1 Core model: retained Scene Graph → Render Graph
- **Scene Graph** describes what exists (panes, series, overlays, axes, HUD, interaction).
- **Render Graph** describes how to draw efficiently (passes, caching, ordering, resource reuse).

#### Scene graph skeleton
- `ChartRoot`
  - `PaneGroup[]`
    - `SeriesLayer[]`
    - `OverlayLayer[]` (drawings, markers)
    - `InteractionLayer` (crosshair, selection)
  - `AxisGroup` (price + time)
  - `HUDLayer` (legend/watermark)

Each node tracks:
- world bounds + screen bounds
- dirty flags (geometry/text/style)
- dependency edges (axis labels depend on scale)

#### Render graph passes (baseline)
1. Background / clear
2. Grid (analytic)
3. Series (instanced candles/lines)
4. Overlays (drawings/markers)
5. Text (MSDF + fallback compositing)
6. Interaction overlay (crosshair/selection) **always last, always cheap**
7. Present

### 5.2 Physical pixel space
V3 defines “truth” in physical pixels:
- render targets allocated at physical pixel size
- snapping and stroke thickness based on physical pixels
- effective DPR may be capped per tier to protect performance on extreme displays

### 5.3 Tile cache + reprojection (the differentiator)

#### Tile model
- pane partitioned into fixed tile grid in physical pixels (e.g., 256×256 or 512×512 depending on tier)
- each tile caches:
  - background/grid (rarely invalid)
  - series historical layer
  - static overlays
- not cached:
  - crosshair/interaction
  - active editing handles

#### Tile states
- `Valid` (fresh)
- `Stale` (displayable while rebuilding)
- `Invalid` (must rebuild; fallback allowed)

#### Invalidation triggers
- zoom level crosses threshold
- theme/style change
- data updates in bar range mapped to tile
- overlay edits within tile bounds

#### Instant pan via reprojection
On pan:
- reproject cached tiles immediately (texture transform)
- rebuild only newly exposed edge tiles asynchronously
- enforce frame budgets so interaction never stutters

### 5.4 Progressive refinement stages
- **Stage 0:** envelope silhouette (min/max per pixel column)
- **Stage 1:** LOD‑correct OHLC/candles
- **Stage 2:** full quality AA + final overlays + stabilized text

Stage 0 is allowed to preempt background work when budgets are tight.

### 5.5 Geometry pipelines

#### Candles (instanced)
- single instanced draw per series per pane
- per-instance attributes: x, o/h/l/c, style flags
- vertex shader expands wick/body geometry

#### Lines/areas
- avoid native `LINES`
- recommended baseline: screen-space quad expansion + distance AA
- cache geometry per LOD chunk

#### Grid (analytic)
- full-screen quad, compute lines in fragment shader
- minimal draw calls; consistent crispness

---

## 6. Text architecture

### 6.1 Hybrid text policy (most robust)
**MSDF (GPU):** digits/Latin axis labels + HUD micro-text (stability under zoom/pan)  
**Canvas2D/DOM:** complex scripts + long annotation text + text editing/IME correctness

### 6.2 MSDF implementation notes
- ship prebaked atlas for digits/Latin + punctuation
- dynamic atlas paging for extra Latin glyphs
- strict atlas memory budget + eviction policy

### 6.3 Text stability rules (anti-shimmer)
- baseline snapping in physical pixels
- label hysteresis (avoid micro re-layout)
- optional scale quantization during kinetic zoom

### 6.4 International shaping roadmap
- V3.0: numeric/Latin
- V3.1+: add shaping engine (e.g., HarfBuzz WASM) + caching of shaped runs

---

## 7. Input and interaction architecture

### 7.1 High-frequency pointer sampling
- use `getCoalescedEvents()` to process intermediate events and smooth motion curves
- use `pointerrawupdate` when supported (feature detect)

### 7.2 Interaction-first scheduler
Every frame:
1. sample latest InputState
2. update camera/transform
3. render interaction overlay
4. draw reprojected tiles
5. schedule tile rebuild/refinement within remaining budget
6. stop before vsync miss

### 7.3 Gesture engine
- pan with inertia (native-like physics)
- wheel/pinch zoom anchored at cursor/pinch center
- mobile gestures: single touch pan, pinch zoom, long press crosshair, double tap reset/fit

---

## 8. Picking and hit‑testing architecture

### 8.1 No hover-time GPU picking (rule)
Hover hit testing must not require GPU readback.

### 8.2 Series hit testing (analytical CPU)
- candle index = inverse transform of x coordinate
- OHLC fetched from CPU buffers
- O(1) for the common case

### 8.3 Drawings hit testing (CPU spatial index)
- grid binning for handles/segments (fast and simple)
- optional R-tree for large object counts
- incremental maintenance on edits

### 8.4 Optional GPU picking (click-only)
If needed for dense scenes:
- render ID buffer offscreen
- read one pixel on click/tap only
- accept 1-frame latency; never block interaction loop

---

## 9. Data‑to‑pixels pipeline

### 9.1 Columnar storage
Use typed arrays (avoid per-bar objects):
- `time[]` (f64 or u64 split)
- `open[]`, `high[]`, `low[]`, `close[]` (f32)
- `volume[]` (f32)

### 9.2 Chunking strategy
- immutable chunks for history
- append-only ring buffer for live ticks
- cheap “visible window view” assembly

### 9.3 LOD pyramid + envelopes
- precompute multiple resolutions (time bucket aggregation)
- build min/max envelopes for Stage 0 silhouette
- viewport selects LOD automatically

### 9.4 Streaming updates
- update only affected tail region
- invalidate only impacted tiles + axis labels
- never trigger full relayout on every tick

---

## 10. Shader toolchain and backend strategy

### 10.1 Canonical shader language: WGSL
- WGSL is source-of-truth for WebGPU pipelines.

### 10.2 Fallback shader generation (Tier C)
- Build-time translation of a portable WGSL subset → GLSL (WebGL2)
- Enforce “portable subset” rules to avoid translation edge cases.

### 10.3 Pipeline warmup
- precompile essential pipelines at startup: candles, grid, text, present
- lazy compile rare pipelines off the interaction path

### 10.4 Render bundles (where beneficial)
- use for static grid and reusable command sequences
- avoid over-bundling dynamic content

---

## 11. Reliability and recovery

### 11.1 Device loss recovery
State machine:
- `Healthy`
- `Degraded` (reduced cache/AA)
- `ReinitPending` (recreate device/pipelines)
- `FallbackTierC`
- `FallbackTierD`

Rules:
- on device lost: attempt reinit + progressive restore
- repeated loss: downgrade tier automatically
- never “blank chart” as final state

### 11.2 Error handling
- push/pop error scopes around risky GPU work (pipeline creation, large allocations)
- central handler for uncaptured GPU errors
- telemetry tagged with tier + device cohort + remote rules hash

### 11.3 Resource pressure handling
- explicit budgets for tiles, atlases, buffers
- eviction policies + quality knob downgrades under pressure

---

## 12. Observability and regression prevention

### 12.1 Runtime metrics (sampled)
- frame time histogram (median/p95/p99)
- input-to-photon estimate
- tile cache hit/rebuild rate
- atlas rebuild events
- device lost + recovery time
- GPU errors (scoped + uncaptured)
- memory budget utilization

### 12.2 Automated perf harness
Deterministic scenes:
- 1k / 10k / 100k candles visible
- heavy overlays (50+ drawings)
- burst streaming ticks
- multi-pane stress

Run across:
- desktop dGPU + iGPU
- mid-range mobile
- Safari and Chrome/Edge

### 12.3 Visual golden tests
- render canonical scenes offscreen
- compare pixel output with tolerance thresholds
- validate snapping, AA stability, label stability

---

## 13. Engineering plan and milestones

Each milestone has explicit “Definition of Done” gates to prevent shipping architecture that looks good on paper but fails in production.

### Milestone 0 — Foundations
**Build**
- tier selector skeleton + capability probes
- Transport abstraction (SAB + Message)
- renderer lifecycle interfaces
- observability baseline

**DoD**
- Tier B can init, render, and cleanly shutdown without leaks
- init failure returns a usable Tier C/D fallback

### Milestone 1 — Tier B WebGPU baseline (premium compatible)
**Build**
- instanced candles + analytic grid
- pan/zoom transforms + physical-pixel snapping
- crosshair overlay + tooltip (no readback)
- visible-window culling

**DoD**
- crosshair contract holds under stress
- no long tasks > 50ms during interaction

### Milestone 2 — Tile cache + progressive refinement
**Build**
- tile cache manager + eviction + budgets
- reprojection pan
- Stage 0 envelope + Stage 1 LOD

**DoD**
- “instant pan” perceptible at large scale
- memory plateaus (no runaway growth in long session)

### Milestone 3 — Hybrid text production
**Build**
- MSDF numeric/Latin axis + HUD
- Canvas2D/DOM fallback for complex scripts + editing
- anti-shimmer rules

**DoD**
- stable labels under zoom/pan
- atlas memory bounded

### Milestone 4 — Tier A WebGPU worker renderer
**Build**
- OffscreenCanvas transfer + worker render loop
- SAB acceleration if available
- automatic downgrade A→B on instability

**DoD**
- Tier A selected only when stable; seamless fallback

### Milestone 5 — Safety renderers + shader toolchain unification
**Build**
- Tier C WebGL2 renderer (minimal)
- Tier D layered Canvas2D safe mode
- WGSL portable subset + build-time translation for Tier C

**DoD**
- never ship a “blank chart” experience

### Milestone 6 — Hardening + release gates
**Build**
- device loss recovery + repeated-loss downgrade
- remote allow/denylist + kill switch
- CI perf + visual regression gates

**DoD**
- stable across representative cohorts
- documented runbook and debug flags

---

## Appendix A: Interfaces

### A.1 Renderer API (TypeScript)
```ts
export interface ChartRenderer {
  init(target: HTMLCanvasElement | OffscreenCanvas, opts: InitOptions): Promise<void>;
  destroy(): void;

  setViewport(vp: Viewport): void;
  setTheme(theme: ThemeTokens): void;

  // Data
  setSeriesData(seriesId: string, data: SeriesBuffers): void;
  appendTicks(seriesId: string, ticks: TickBatch): void;

  // Interaction
  setInputState(state: InputState): void; // or reads from TransportSAB
  renderFrame(nowMs: number): void;

  // Diagnostics
  getStats(): RendererStats;
}
```

### A.2 Transport API
```ts
export interface Transport {
  mode: "SAB" | "Message";
  writeInput(state: InputState): void;
  readInput(): InputState;
  sendDataChunk(chunk: ArrayBuffer): void;
}
```

---

## Appendix B: Tier selection algorithm

1. Load remote config (allow/deny rules, defaults)
2. Feature detect:
   - WebGPU availability
   - worker + OffscreenCanvas viability
   - adapter limits/features
3. Microbenchmark (very small, fast):
   - tiny instanced draw
   - tiny texture upload
   - tiny text pass
4. Select tier:
   - Tier A if worker path viable + benchmark ok + not blocklisted
   - Tier B if WebGPU ok but worker path not viable
   - Tier C if WebGPU fails/unstable
   - Tier D if WebGL2 fails/unavailable

---

## Appendix C: Acceptance benchmarks

### C.1 “Feel” gates
- crosshair remains smooth at high pointer rates under heavy load
- pan shows motion immediately (reprojection) on large scenes

### C.2 Frame pacing gates
- interaction p95 frame time stable under defined stress scenes
- no sustained vsync misses during common workflows

### C.3 Memory stability gates
- tile cache and atlas memory plateau under prolonged interaction
- no leaks across repeated init/destroy cycles

---

## Notes
This Markdown file is intended to be the canonical “V3 Spec” doc. If you want, we can also produce:
- a V3.1 “Backlog/epics” version with ticket-sized acceptance criteria,
- a V3.1 “Engineering blueprint” with message schemas (SAB rings, postMessage packets), GPU pass layouts, and concrete resource budget tables.
