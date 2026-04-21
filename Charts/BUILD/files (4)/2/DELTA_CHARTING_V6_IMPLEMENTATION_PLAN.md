# Delta Charting V6 — Cursor Execution Plan (Canvas2D-Only)

**Generated:** 2026-01-06  
**Starting point:** current V5.2 monorepo implementation

This plan is written so that **each phase can be completed in a single Cursor session** with clear DoD and tests.

---

## 0) Ground rules for Cursor sessions

- Do not mix phases.
- Keep changes small and testable.
- After each phase:
  - `pnpm test` (or repo equivalent)
  - run perf harness scenario(s)
  - run demo manually for 2 minutes: pan/zoom/crosshair/append-data
- No performance optimizations without measurement.

---

## Phase 0 — V6 Branch Setup + “Canvas2D only” enforcement

### Objective
Make it impossible for the runtime to select WebGPU/WebGL. Canvas2D is the only renderer.

### Tasks
1. In `packages/chart-core/src/tier-detection.ts`:
   - replace tier logic with Canvas2D-only detection (or remove tiers).
2. In `packages/chart-core/src/renderer-factory.ts`:
   - always return Canvas2D renderer.
   - remove/disable WebGPU/WebGL imports so bundlers can tree-shake them.
3. In root exports / public API:
   - ensure `chart-render-webgpu` is not a dependency of the default build.
4. Add a unit test:
   - `createRenderer()` returns Canvas2D even if `navigator.gpu` exists.

### Definition of Done
- Default build has **no WebGPU/WebGL code path** reachable.
- Bundled output no longer includes WebGPU renderer package (verify via build stats if available).
- All tests pass.

---

## Phase 1 — Refactor the 10k-line Canvas2D renderer into modules (no behavior change)

### Objective
Reduce risk and enable V6 improvements safely.

### Target structure (example)
`packages/chart-render-canvas2d/src/`
- `create-chart.ts` (public entry)
- `chart-controller.ts`
- `runtime/frame-scheduler.ts` (or re-export from chart-core)
- `layers/layer-stack.ts`
- `layers/pan-cache.ts`
- `render-passes/underlay-pass.ts`
- `render-passes/series-pass.ts`
- `render-passes/overlay-pass.ts`
- `series/candlestick-renderer.ts`
- `series/line-renderer.ts`
- `axes/axis-renderer.ts`
- `grid/grid-renderer.ts`
- `debug/render-stats.ts`

> You can keep file names flexible, but keep responsibilities separated.

### Tasks
1. Move code without behavior changes (pure refactor).
2. Add minimal integration tests around:
   - create/destroy lifecycle
   - add series and setData
   - pan + zoom changes visible range
3. Ensure perf harness still matches V5.2 baseline.

### Definition of Done
- `index.ts` shrinks substantially and mostly re-exports.
- No behavioral regressions in demo/perf harness.

---

## Phase 2 — Pixel Snapping v2 (eliminate shimmer)

### Objective
Centralize pixel snapping rules and apply across grid/axes/crosshair and candle strokes.

### Tasks
1. Create `packages/chart-render-canvas2d/src/rendering/pixel-snap.ts`:
   - `snapStroke(valueCssPx, lineWidthCssPx, scaleX, scaleY)` (or simpler API)
   - `snapRect(x, y, w, h)` returning integer-aligned rect for fills
2. Replace all ad-hoc `Math.round(x)+0.5` in:
   - grid renderer
   - axis renderer
   - crosshair renderer
   - any 1px strokes
3. Add unit tests for pixel-snap at DPRs: 1.0, 1.25, 1.5, 2.0

### Definition of Done
- No visible shimmer on slow pan at non-integer DPR.
- Visual regression snapshots pass.

---

## Phase 3 — Axis “Hysteresis” + Label Layout v2 (no tick jitter)

### Objective
Axes should feel stable: tick steps and labels don’t jump around with tiny zoom/pan changes.

### Tasks
1. Implement a tick generator with hysteresis:
   - choose a tick step based on range and target tick count
   - apply hysteresis so step changes only after thresholds
2. Implement deterministic label placement:
   - avoid overlaps
   - stabilize anchor points
3. Add caching:
   - memoize ticks by (range, step, pixelHeight, theme font metrics)
4. Add tests:
   - zoom slowly and assert tick step doesn’t change too often
   - labels never overlap given min spacing

### Definition of Done
- Axis ticks stable under slow zoom.
- No overlap in typical ranges.
- Perf: axis redraw < 2ms P95 when dirty.

---

## Phase 4 — Input Pipeline v2 (coalesced events + deterministic intent)

### Objective
Lower input overhead and improve velocity tracking for inertia, without sacrificing direct manipulation.

### Tasks
1. In `chart-interaction`:
   - add an `InputRouter` that:
     - consumes pointer/wheel events
     - uses `getCoalescedEvents()` when present
     - records velocity with a ring buffer (no allocations)
2. Update `FrameScheduler` usage:
   - queue only the latest “intent” per frame (pan delta, wheel delta, pointer pos)
3. Verify:
   - direct manipulation remains 1:1
   - inertia velocity feels consistent across refresh rates

### Definition of Done
- Input processing < 2ms P95 in perf harness.
- No “lag” during drag.
- Inertia feels unchanged or better than V5.2.

---

## Phase 5 — Progressive Render + Frame Budget Manager

### Objective
Maintain a premium feel under heavy loads by rendering something fast first, refining after.

### Tasks
1. Add a `FrameBudget` helper:
   - measure per-layer render cost
   - expose “over budget” signal
2. Implement progressive refine:
   - during active interaction: prefer pan cache / LOD
   - after interaction settles: schedule full-quality redraw
3. Add perf harness scenario:
   - heavy indicator(s) + pan/zoom
   - verify P95 frame time remains within budget

### Definition of Done
- P95 pan frame time improves (or remains stable) under heavy scenarios.
- Users see immediate response; refinement happens after.

---

## Phase 6 — Optional: Worker Offload Improvements (Canvas2D, not WebGPU)

> This is **optional** for V6.0 and can be V6.1 if risky.

### Objective
Offload expensive indicator computation and/or series preparation to workers without per-frame main-thread stalls.

### Tasks
1. Ensure indicator computations run in worker with transferable typed arrays.
2. Add a “render preparation worker” for expensive decimation/LOD selection if needed.
3. Keep rendering on main thread unless profiling proves benefit.

### Definition of Done
- Main thread time during pan/zoom decreases in heavy scenarios.
- No correctness regressions.

---

## Phase 7 — Instrumentation & Debug Overlay (must-have)

### Objective
Make performance visible and debuggable during development and in QA.

### Tasks
1. Implement `__chartsPlusDebug` (or similar) API:
   - frame times histogram (P50/P95/P99)
   - per-layer render times
   - pan cache hit-rate
   - allocations per frame (best-effort)
2. Add a debug overlay plugin in demo:
   - toggleable HUD

### Definition of Done
- Dev can identify regressions in minutes.
- Perf harness outputs include the key stats.

---

## Phase 8 — Release checklist

- Update version numbers (V6)
- Update docs: “Canvas2D-only” stance
- Migration notes (if any)
- Perf baseline captured in repo
- Demo updated

---

## Suggested order (most optimal)
1) Phase 0 (Canvas2D-only enforcement)  
2) Phase 1 (refactor for safety)  
3) Phase 2 (pixel snapping v2)  
4) Phase 3 (axis stability)  
5) Phase 4 (input pipeline v2)  
6) Phase 5 (progressive render + budget)  
7) Phase 7 (instrumentation)  
8) Phase 6 optional (workers)  
9) Phase 8 release

