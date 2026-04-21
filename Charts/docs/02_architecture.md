# Architecture (v1)

## Module boundaries

- `packages/chart-core`
  - Data model (columnar storage, binary search).
  - Scales (time/price), tick generation, formatting.
  - Layout engine (pane + axes rectangles) and invalidation model.
  - Frame scheduler and input coalescing (events → per-frame intent).
- `packages/chart-render-canvas2d`
  - CanvasSurface (ResizeObserver + DPR scaling + pixel snapping).
  - Layered rendering: underlay (grid/axes), series, overlay (crosshair/hover).
  - Series renderers (LineSeries first) and decimation adapters.
- `apps/demo`
  - Showcase pages and manual validation (crispness, gaps, themes, multi-series).
- `apps/perf-harness`
  - Playwright-driven perf scenarios and regression comparison (added once interactions exist).

## Frame pipeline

1. **Input coalescing**
   - Wheel/pointer/touch events are collected into a per-frame intent.
2. **State update**
   - Apply intent (pan/zoom/cursor) to chart state.
3. **Layout (if dirty)**
   - Recompute rectangles, ticks, label placements.
   - Measure text only here; cache by `(font, text)`.
4. **LOD / decimation**
   - Convert visible data into ~O(plotWidth) draw buffers (envelope min/max buckets).
5. **Render layers**
   - Underlay: grid + axes (only on layout changes).
   - Series: decimated paths (on series or view changes).
   - Overlay: crosshair + hover UI (on pointermove).

## Time scale model

- Visible range is expressed in time units `{ from, to }` (ms since epoch).
- Spacing is linear in time (real gaps are shown).
- Mapping:
  - `timeToX(t)` and `xToTime(x)` are linear transforms based on visible range and plot width.
- Visible index range:
  - Use binary search (`lowerBound`, `upperBound`) over the series `time[]` array to find visible indices quickly.
