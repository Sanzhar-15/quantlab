# Delta Charting Engine V3 — Engineering Blueprint
**WebGPU-first • capability-tiered • tile-cached • progressive refinement • production-resilient**

This is the engineering blueprint that turns the V3 spec into an implementable plan.

> Design principle: **Protect interaction smoothness above all else.**  
> Everything else (tile refinement, indicator recompute, text rebuild) is scheduled around that rule.

---

## 1) Architectural goals (engineering terms)

### 1.1 Smoothness invariants
- **Frame pacing > average FPS**: avoid spikes (p95/p99) more than chasing 120 fps.
- **Input-to-photon latency** minimized by:
  - always reading latest input state at frame start
  - isolating interaction overlay pass
  - avoiding stalls (GPU readback on hover, long main-thread tasks, GC churn)

### 1.2 Visual quality invariants
- **Physical-pixel truth**: allocate render targets in device pixels and snap in device pixels.
- **Stable text**: numeric axis labels never shimmer while panning/zooming.
- **Consistent strokes/widths**: candle widths and 1px lines remain stable under transforms.

### 1.3 Production invariants
- **Never blank chart**: if Tier A fails, drop to Tier B; if WebGPU fails, drop to Tier C; if needed, Tier D.
- **Bounded memory**: tile cache, glyph atlas, buffers must have budgets + eviction.
- **Recoverable device loss**: state machine around device/context failure; progressive restore.

---

## 2) Capability-tiered runtime model (what ships)

We support 4 tiers. The engine auto-selects and can auto-downgrade.

- **Tier A:** WebGPU render worker (ideal)
- **Tier B:** WebGPU main-thread renderer (still premium)
- **Tier C:** WebGL2 safety renderer (reduced fidelity; preserves UX invariants)
- **Tier D:** Canvas2D safe mode (minimal; layered; “always works”)

The tier affects:
- where rendering runs (worker vs main)
- max DPR and tile size
- allowed effects (MSAA, post)
- fallback text strategy
- budgets (tiles/atlas/buffers)

**Key rule:** *Tier selection is deterministic and observable* (logs why a tier was chosen).

---

## 3) Core dataflow (end-to-end)

### 3.1 High-level flow
1. **Input capture (main thread)** → normalize → Transport (SAB rings or message packets)
2. **Data ingestion (Data Worker)** → columnar store → LOD + envelopes → “render-ready” buffers/messages
3. **Renderer (Tier A/B)** reads input + data, updates scene graph, builds render graph, schedules work
4. **GPU** renders cached tiles + interaction overlay → present

### 3.2 Ownership model
- **Main thread** owns DOM/UI and only lightweight orchestration.
- **Data Worker** owns parsing, LOD building, indicator compute baseline (CPU/WASM).
- **Renderer runtime** owns:
  - GPU device/context
  - resource manager
  - tile cache
  - render graph execution
  - text atlas (MSDF) + fallback compositing

---

## 4) Engine subsystems (what to build)

### 4.1 Subsystem list
- Capability/Tier Manager
- Transport Layer (SAB + message)
- Data Store + LOD Pyramid
- Layout + Axes + Tick Generation
- Scene Graph (semantic objects)
- Damage Tracking (dirty flags/rects/ranges)
- Tile Cache (keys, eviction, reprojection)
- Render Scheduler (budgets + priorities)
- WebGPU Backend (pipelines/passes)
- Text System (MSDF + fallback)
- Interaction Engine (gestures, crosshair, selection)
- Hit Testing (CPU spatial indices + optional click-only GPU pick)
- Resource Manager (textures/buffers/pools)
- Resilience Layer (device loss + errors + downgrade)
- Observability + Perf Harness + Golden Tests

---

## 5) Scene graph & render graph (implementation detail)

### 5.1 Scene graph nodes (suggested)
- `ChartRoot`
  - `PaneGroup`
    - `Pane` (main + indicator panes)
      - `SeriesLayer[]`
      - `OverlayLayer[]`
      - `InteractionLayer`
  - `AxisGroup` (time axis + per-pane price axis)
  - `HUDLayer`

**Each node stores:**
- `boundsWorld`, `boundsScreen`
- `zIndex`
- `dirtyFlags` (bitmask)
- dependencies: “axis labels depend on scale”

### 5.2 Render graph (passes)
A minimal, stable pass list (Tier A/B):
1. **Clear/Background**
2. **Grid** (analytic shader)
3. **Series** (instanced candles/lines)
4. **Overlays** (drawings/markers)
5. **Text** (MSDF + fallback composite)
6. **Interaction Overlay** (crosshair/selection) — always last & cheap
7. **Present/Blit** (if intermediate targets used)

Tier C/D map to equivalent conceptual passes, even if implemented differently.

---

## 6) Tile cache blueprint (core differentiator)

### 6.1 Tile definition
- Tile is defined in **physical pixel coordinates**.
- Tile size (defaults):
  - Desktop Tier A/B: 512 px
  - Mobile Tier A/B: 256 px
- Overscan: keep 1–2 tiles outside viewport to mask fast pan

### 6.2 Tile key structure
A tile key must include everything that affects appearance:

```text
TileKey = {
  paneId,
  layerMask,            // which cached layers are inside this tile
  lodLevel,             // chosen LOD for this zoom
  themeRevision,        // increments on theme change
  dataRevisionRange,    // identifies which data revision touches this tile
  overlayRevision,      // increments on overlay edits inside bounds
  pixelRatioBucket,     // effective DPR bucket (e.g. 1.0–1.25–1.5–2.0)
  tileX, tileY
}
```

### 6.3 Reprojection pan
On pan, reuse tile textures:
- translate tile grid mapping by pan delta
- render newly exposed edge tiles asynchronously
- show stale tiles while rebuilding

### 6.4 Progressive refinement
Stage 0/1/2 strategy:
- Stage 0: envelope silhouette (min/max per pixel column)
- Stage 1: LOD OHLC/candles
- Stage 2: full quality (AA polish, overlays)

**Scheduler rule:** Stage 0 is always allowed to preempt Stage 2.

---

## 7) WebGPU backend blueprint

### 7.1 Resource layout (recommended)
- Use **one bind group per pass** where possible
- Prefer **uniform buffers** for small state (camera, theme) and **storage buffers** for instance/vertex data
- Use **texture arrays** (or atlas pages) to store many tile textures efficiently (implementation choice)

### 7.2 Candle renderer (instanced)
- Instance buffer per series (or per LOD chunk)
- Vertex shader expands wick/body; fragment shader applies color/theme.
- Highlight overlays (hovered bar, selection) handled by a small overlay pass or style flags.

### 7.3 Grid (analytic)
Draw one full-screen quad per pane; compute grid lines based on:
- camera transform
- tick spacing chosen by axis engine

### 7.4 Lines
Baseline: analytic quads + distance-based AA (stable thickness).
Optional later: compute-assisted join refinement if needed.

### 7.5 MSAA / post
- Tier A/B desktop may enable MSAA for series pass if needed.
- Keep post minimal and optional (avoid extra bandwidth unless proven beneficial).

---

## 8) Text blueprint (MSDF + fallback)

### 8.1 Two text lanes
**Lane A:** MSDF for numeric/Latin axis labels + HUD microtext  
**Lane B:** Canvas2D/DOM fallback for complex scripts + editing overlays

### 8.2 Atlas management
- Ship a prebaked atlas for digits/Latin.
- Dynamic atlas pages for new glyphs.
- Enforce memory budgets; evict least-used pages first.
- Cache shaped runs (later) and glyph metrics.

### 8.3 Stability rules
- baseline snap in physical pixels
- label hysteresis to avoid micro re-layout
- quantize text scale during kinetic zoom (optional)

---

## 9) Transport + messaging blueprint

We standardize all cross-thread comms to a small set of message types and an optional SAB ring format.

- InputState is either:
  - written into SAB at high frequency, or
  - coalesced and posted as messages
- Data updates are chunked and sent as:
  - transferable ArrayBuffers (message mode)
  - SAB ring segments (turbo mode)

Details are in `02_Transport_and_Messaging.md`.

---

## 10) Picking & hit testing blueprint

### 10.1 No-hover-readback rule
No GPU readback on pointer move.

### 10.2 Series picking (O(1))
Bar index = inverse transform of pointer X coordinate.
Tooltip values fetched from CPU columnar arrays.

### 10.3 Drawings picking (CPU spatial index)
- grid bins for handle points and segments
- optional R-tree for large scenes
- update index incrementally on edits

### 10.4 Optional click-only GPU pick
If needed for extreme overlay density:
- render ID texture offscreen
- read 1 pixel on click only
- accept 1-frame latency (async pipeline)

---

## 11) Data pipeline blueprint

### 11.1 Storage format
Use typed arrays and chunking:
- `time[]` as f64 (or u64 split) with origin+offset logic for shader precision
- prices as f32 with base+scale mapping
- immutable chunks for history, ring buffer for live

### 11.2 LOD pyramid
- precompute zoom levels
- min/max envelopes for Stage 0
- renderer selects LOD to ensure “no more points than pixels”

### 11.3 Streaming updates
- update only tail region
- invalidate only tiles whose x-range intersects updated bars
- avoid global relayout

---

## 12) Resource management blueprint

### 12.1 Budgets (tiered defaults)
Example defaults (tune empirically):
- Desktop Tier A/B: tiles 192MB, atlas 48MB, dynamic buffers 64MB
- Mobile Tier A/B: tiles 96MB, atlas 24MB, dynamic buffers 32MB

### 12.2 Eviction strategies
- tile LRU weighted by viewport proximity and “recently seen”
- atlas LRU by glyph usage and text lane priority
- buffer pools and ring buffers to avoid allocations and GC

---

## 13) Resilience blueprint

### 13.1 Device loss state machine
States:
- Healthy → Degraded → ReinitPending → (Recovered | TierDown)

### 13.2 Error scopes & telemetry
- Wrap pipeline creation and large allocations in error scopes.
- Capture uncaptured GPU errors centrally.
- Log tier, device cohort metadata, and config hash to diagnose.

---

## 14) Observability blueprint

### 14.1 Metrics
- frame pacing histogram (median/p95/p99)
- input-to-photon estimate
- tile cache hit % and rebuild counts
- atlas page churn
- device loss count + recovery time
- memory budget utilization by subsystem

### 14.2 CI gates
- perf harness scenes for regression detection
- visual golden tests for stability (snapping, label jitter, AA)

---

## 15) Implementation order (golden path)

**Build Tier B first** (WebGPU main thread) to remove worker canvas variability from early milestones.
Then add Tier A as an optimization.

Milestones are detailed in `10_Epics_Backlog_and_DoD.md`.
