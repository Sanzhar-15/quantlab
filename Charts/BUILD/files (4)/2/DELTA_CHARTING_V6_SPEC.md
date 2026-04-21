# Delta Charting V6 (Canvas2D-Only) — Specification & North Star

**Status:** Draft for implementation  
**Generated:** 2026-01-06  
**Audience:** Cursor execution + maintainers

---

## 0. Context: what we are building (V6 mission)

Delta Charting V6 is a **Canvas2D-only** trading chart engine that aims to exceed TradingView-style “pro chart feel” in three measurable pillars:

1) **Rendering Quality** — true HiDPI sharpness and professional crispness  
2) **Smoothness** — sustained frame pacing under pan/zoom/streaming  
3) **UX Quality** — interaction that is predictably correct for traders

V6 does **not** ship WebGPU or WebGL. Canvas2D is the only runtime renderer.

This spec assumes the current baseline is Delta Charting **V5.2**, which already provides:
- devicePixelContentBox HiDPI handling
- direct manipulation (0ms lag during drag)
- friction-based inertia (“iOS-like”)
- Path2D batching for candles
- pan-cache optimization layer
- performance harness + layered rendering architecture

(See the provided V5.2 system documentation for current behavior and architecture.)

---

## 1. Non-negotiables (hard requirements)

### 1.1 Canvas2D-only
- The runtime renderer is Canvas2D in all environments.
- Any WebGPU/WebGL code paths are removed from default builds and **cannot be auto-selected**.

### 1.2 Direct manipulation rule
While pointer is down and a drag gesture is active:
- viewport changes are **1:1** with input delta
- **no smoothing, no springs, no easing**
- velocity tracking is allowed *only* to power inertia after release

### 1.3 Zero-jank principles
- No per-frame allocations in hot paths (render loop, input loop).
- Frame pacing is prioritized over raw average FPS.

### 1.4 Pixel-perfect output
- Use `devicePixelContentBox` when available; otherwise DPR fallback.
- All crisp 1px lines must be snapped correctly (no shimmer/jitter on slow pan).

### 1.5 Deterministic degradation (optional)
If V6 introduces quality scaling (e.g., for extreme datasets):
- it must be deterministic, measurable, and reversible
- and must never break correctness (only visual fidelity temporarily)

---

## 2. V6 targets (measurable)

> Targets assume a modern desktop CPU and typical trading datasets.  
> Perf harness must validate these as P95 unless stated otherwise.

### 2.1 Rendering performance
- **10k candles**: render < **8ms P95** (better than V5.2 baseline)
- **Pan frame time** (cache hit): < **6ms P95**
- **Pan frame time** (cache miss, re-render): < **16.67ms P95**
- **Crosshair overlay**: < **0.75ms P95**
- **Axis/grid redraw**: < **2ms P95** when dirty, ~0ms when clean

### 2.2 Interaction latency
- **Pointer move → internal state update**: < **2ms P95**
- **Pointer move → next-frame present**: within **1 refresh interval** (display-dependent)
- Crosshair must never “chase” pointer under normal load.

### 2.3 Stability & correctness
- No visible “tick jitter” on axes during gentle pan/zoom.
- No blurry grid/crosshair lines at common DPRs (1.0, 1.25, 1.5, 2.0).
- No dropped frames > 1% in standard harness scenarios.

---

## 3. Architecture (V6 reference model)

### 3.1 Packages (keep monorepo model)
- `chart-core`: types, scales, layout engine, invalidation, frame scheduler, theme, data structures
- `chart-render-canvas2d`: Canvas2D renderer + layer stack + pan cache
- `chart-interaction`: gesture engine + velocity tracking + inertia controller
- `chart-indicators`: indicator compute engine (worker-friendly)
- `chart-drawings`: drawings + hit-testing + undo/redo
- `chart-transforms`: normalization / percent / z-score etc.
- `chart`: high-level public API wrapper
- `apps/demo`, `apps/perf-harness`: integration + performance regression tests

### 3.2 Layer stack (V6 standard)
V6 standardizes the layered renderer to **4 physical canvases**, matching V5.2’s proven architecture:
1. **underlay**: background + grid + axes (mostly static/viewport)
2. **seriesLayer**: primary series drawing (candles/lines)
3. **panLayer**: pan cache (pre-rendered overscan)
4. **overlay**: crosshair + tooltips + transient UI

> V6 allows additional layers only if perf harness proves necessity.

### 3.3 Render scheduling (single source of truth)
- V6 uses a single frame scheduler that:
  - batches invalidations
  - coalesces input intent
  - executes a frame pipeline:
    1) input processing (coalesced)
    2) state update (viewport/physics)
    3) prepare visible data
    4) render dirty layers (budget-aware)
    5) publish events (crosshair move, viewport change)

### 3.4 Data pipeline
- Typed-array stores for time-series and OHLC data.
- Visible-range queries must be O(log N) + O(K) where K is visible count.
- LOD pyramid/decimation must be selectable per series based on pixels-per-point.

---

## 4. V6 key innovations (what changes vs V5.2)

### 4.1 Pixel-snapping system v2 (shimmer elimination)
Replace ad-hoc `Math.round(x)+0.5` patterns with a centralized module:
- `snapStrokePx(valueCss, lineWidthCss, dpr)` → snapped coordinate
- `snapRectPx(x, y, w, h, dpr)` → integer-aligned rect
- Rules must account for:
  - non-integer DPR (1.25, 1.5)
  - arbitrary `ctx.setTransform(...)` (dpcb scaling)

**Outcome:** grid/crosshair/axis strokes do not shimmer while panning.

### 4.2 Axis ticks “hysteresis” (anti-jitter)
Introduce tick-step hysteresis:
- tick step does not change unless zoom crosses a meaningful threshold
- major/minor ticks stable across small pan/zoom changes
- label placement avoids overlap deterministically

**Outcome:** professional axes feel stable.

### 4.3 Progressive refine (perceived performance)
Introduce a two-phase render for expensive situations:
- **interaction phase**: show immediate result using cache/LOD (fast)
- **refine phase**: after input settles, schedule a full-quality redraw (idle/next frames)

**Outcome:** consistent “buttery” feel under heavy loads.

### 4.4 Optional (guarded) spring usage
V6 can include a spring solver only for:
- **non-interactive transitions** (e.g., autoscale settling after drag stops)
- **snap-to behaviors** where overshoot is forbidden (critically damped)

Springs are **never** used while pointer is down during direct manipulation.

---

## 5. Quality gates (definition of done for V6.0)

### 5.1 Performance gates
- Perf harness runs in CI and compares against baseline.
- Regressions over threshold fail the build.

### 5.2 Visual gates
- Visual regression snapshots for:
  - crisp lines at multiple DPRs
  - axis label spacing stability
  - crosshair alignment and snapping

### 5.3 API stability
- Public API remains backward compatible with V5.2 for:
  - createChart
  - add series
  - set data / append data
  - event subscriptions
  - destroy lifecycle

If any breaking change is required, V6 must provide a codemod or migration guide.

---

## 6. V6 risk register (what can break “most advanced”)

1) **GC jank** from per-frame allocations (Path2D recreation, arrays)  
2) **Tick jitter** that makes the chart feel cheap  
3) **Crosshair chasing** under load (perceived latency)  
4) **Layer explosion** (too many canvases increases compositor cost)  
5) **Unbounded cache memory** (pan cache + LOD caches)

V6 must include instrumentation for all five risks.

---

## 7. V6 release notes template (for adoption)

- What changed vs V5.2
- Performance baseline deltas (P95)
- Known limitations
- Feature flags (if any) and defaults
- Migration steps (if any)
