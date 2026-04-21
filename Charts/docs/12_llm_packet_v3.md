# LLM Packet (V2 State + V3 Planning Inputs)

This is a single, self-contained reference for V3 planning. It summarizes the current V2
implementation, API contracts, architecture, performance gates, and all relevant paths.

## 1) Scope + North Star

- Product: website-embedded financial/macro line charts.
- Data: irregular timestamps, gaps, multiple series, normalization transforms.
- Rendering: Canvas2D core, crisp strokes via DPR-aware snapping.
- Non-goals: candlesticks, TA tools, drawing tools, complex annotations.
- Optional GPU (WebGL/WebGPU) is out of scope and remains opt-in only.

Source: `docs/00_north_star.md`

## 2) Current Status (V2)

- V2 is complete per `docs/03_v2_plan.md`.
- Optional WebGL backend is intentionally not built.
- Worker path for LOD + series rendering exists and is opt-in by import.
- Demo and perf harness apps are implemented.

Source: `docs/11_current_state.md`

## 3) Repository Layout (Key Paths)

- Core API/types: `packages/chart-core/src/api.ts`, `packages/chart-core/src/index.ts`
- Core data + perf:
  - `packages/chart-core/src/data-store.ts`
  - `packages/chart-core/src/chunked-data-store.ts`
  - `packages/chart-core/src/data-provider.ts`
  - `packages/chart-core/src/line-decimator.ts`
  - `packages/chart-core/src/lod-pyramid.ts`
  - `packages/chart-core/src/frame-scheduler.ts`
  - `packages/chart-core/src/time-scale.ts`
  - `packages/chart-core/src/price-scale.ts`
  - `packages/chart-core/src/layout-engine.ts`
- Canvas renderer:
  - `packages/chart-render-canvas2d/src/index.ts`
  - `packages/chart-render-canvas2d/src/canvas-surface.ts`
  - `packages/chart-render-canvas2d/src/worker.ts`
- Demo:
  - `apps/demo/src/main.ts`
  - `apps/demo/src/plugins.ts`
- Perf harness:
  - `apps/perf-harness/src/main.ts`
  - `apps/perf-harness/tests/perf.spec.ts`
- Docs + budgets:
  - `docs/01_api_spec.md` (V1 frozen)
  - `docs/04_v2_api_contract.md`
  - `docs/06_perf_baselines.md`
  - `docs/07_bundle_size.md`
  - `docs/09_release_checklist.md`
  - `config/bundle-budgets.json`

## 4) Architecture Summary

Module boundaries (V1/V2):
- `chart-core`: data model, scales, layout, invalidation, input coalescing.
- `chart-render-canvas2d`: CanvasSurface, layered rendering, line series renderer.
- `apps/demo`: UI and examples.
- `apps/perf-harness`: deterministic perf measurement and baselines.

Frame pipeline:
1) Coalesce input (wheel/pointer/touch) into per-frame intent.
2) Update state (pan/zoom/cursor).
3) Recompute layout if invalidated (measure text here only).
4) LOD/decimation to ~O(plotWidth) buffers.
5) Render layers: underlay (grid/axes), series, overlay (crosshair/hover).

Source: `docs/02_architecture.md`

## 5) API Surface (V1 + V2 Contract)

V1 (frozen):
- `createChart(container, options)`
- `chart.addLineSeries(options)`
- `series.setData`, `series.append`, `series.updateLast`
- `chart.setVisibleTimeRange`, `chart.getVisibleTimeRange`
- `chart.onCrosshairMove(cb)`
- `chart.setTheme`, `chart.destroy`

V2 additions (locked behaviors):
- Time formatting:
  - Data always in epoch ms.
  - `timeZone` affects formatting only (default `utc`).
  - `timeFormatter` optional.
- Axis formatting:
  - `axis.left` / `axis.right`, `format` in `decimal|percent|bps`.
  - `valueFormatter` per series overrides axis format.
- Multi-axis:
  - `axis: 'left' | 'right'` per series (default `left`).
  - `chart.setAxisOptions(axis, options)`
- Memory budgets:
  - `memory.dataBytes`, `memory.lodBytes`, `memory.decimatorBytes`
- Worker series rendering:
  - `seriesRenderer: 'main' | 'worker' | 'auto'`
  - Enable by import: `@charts-plus/chart-render-canvas2d/worker`
- DataProvider (virtualized data):
  - `getRange` + optional `subscribe`
  - `DataProviderOptions`: prefetch, backpressure, outOfOrder, chunkSize, maxChunks, maxBytes

Core semantics:
- `setData` requires strictly increasing time values.
- `append` requires `t > lastTime`.
- `updateLast` requires `t >= lastTime` (replace or append).
- `null` creates gaps; interpolation only between finite neighbors.

Source: `docs/01_api_spec.md`, `docs/04_v2_api_contract.md`

## 6) Data + Memory Model

- DataStore (static) + ChunkedDataStore (virtualized).
- ChunkedDataStore supports:
  - Fixed chunk sizes, typed arrays, monotonic time.
  - Eviction by `maxChunks` or `maxBytes`.
  - Per-chunk stats: min/max/variance/gap count.
- Memory policy:
  - Visible window retained with padding.
  - Evict outside range + reduce LOD under pressure.
  - LOD budget trims higher-resolution levels first.

Key files:
- `packages/chart-core/src/data-store.ts`
- `packages/chart-core/src/chunked-data-store.ts`
- `packages/chart-core/src/data-provider.ts`
- `packages/chart-core/src/lod-pyramid.ts`

## 7) Rendering + UX

- Layered canvases: underlay, series, overlay.
- CanvasSurface handles DPR scaling and pixel snapping.
- Series rendering can run on main thread or worker via OffscreenCanvas.
- Crosshair renders overlay only; last-value pills.
- Plugins:
  - Hooks: `onInit`, `onRenderUnderlay`, `onRenderOverlay`, `onPointer`.
  - Example plugins in demo: threshold band, event markers.

Key files:
- `packages/chart-render-canvas2d/src/index.ts`
- `packages/chart-render-canvas2d/src/canvas-surface.ts`
- `apps/demo/src/plugins.ts`

## 8) Perf Harness + Baselines

Scenarios:
- SCENARIO_A: 3 x 10k points (irregular).
- SCENARIO_B: 2 x 200k points (irregular).
- SCENARIO_C: 1 x 2M points (irregular).

Interactions:
- Wheel zoom in/out.
- Drag pan.
- Pointer sweep across plot.

Metrics:
- Frame times (median, p95, mean, max).
- Input latency: pointermove/drag/wheel (RAF-based).
- Long task durations.
- Heap + working set samples.

Baseline policy:
- Record on pinned machine: `npm run perf:record`.
- Compare on pinned machine: `npm run perf:check`.
- Optional local dry run: `PERF_SKIP_COMPARE=1 npm run perf:check`.

Env vars:
- `PERF_RECORD=1`: record baselines.
- `PERF_SKIP_COMPARE=1`: skip baseline comparisons (local).
- `PERF_INPUT_LATENCY_SLACK_MS=<float>`: add absolute slack to input latency comparisons.

Key files:
- `apps/perf-harness/src/main.ts`
- `apps/perf-harness/tests/perf.spec.ts`
- `docs/06_perf_baselines.md`
- `perf/baselines/<browser>/<library>/`
- `perf/results/<browser>/<library>/`

## 9) Bundle Size + CI Gates

Budgets (gzip):
- core + canvas2d: soft 61 KB, hard 64 KB
- optional workers: soft 8 KB, hard 10 KB
- optional WebGL: soft 8 KB, hard 10 KB

Commands:
- Build: `npm run build`
- Unit tests: `npm test`
- Smoke tests: `npm run test:playwright:smoke`
- Size gates: `npm run size`
- Perf check (pinned): `npm run perf:check`
- Perf record (pinned): `npm run perf:record`

Sources:
- `docs/07_bundle_size.md`
- `config/bundle-budgets.json`
- `docs/09_release_checklist.md`
- `.github/workflows/ci.yml`, `.github/workflows/perf.yml`

## 10) Demo + Usage

Demo:
- `apps/demo` (Vite).
- Start: `npm run dev -w @charts-plus/demo`.

Optional worker rendering:
```ts
import '@charts-plus/chart-render-canvas2d/worker';
import { createChart } from '@charts-plus/chart-render-canvas2d';

createChart('chart', { autoSize: true, seriesRenderer: 'auto' });
```

Source: `docs/05_getting_started.md`

## 11) Known Behavior Notes

- Last-value marker pills render on the series axis side (left by default).
- Worker path only activates when the worker entrypoint is imported.
- Input latency sampling is RAF-based and clamped to >= 0.

Source: `docs/11_current_state.md`

## 12) V3 Plan (Baseline Draft)

High-level goals:
- Higher throughput real-time streaming (10k+ pts/s).
- Multi-pane layouts with synced time scale.
- Optional compression for long history while keeping lossless default.
- Distinct visual identity and rich overlays.

Targets:
- Lower interaction latency and tighter frame-time targets than V2.
- New scenarios D/E:
  - D: 10 x 2M mixed axes (heavy).
  - E: streaming 10k pts/s (stability).

Phases:
1) V3 contract + new benchmarks.
2) Data pipeline v2 (compression + compaction).
3) Multi-pane rendering pipeline.
4) Interaction + UX upgrades.
5) Plugin + overlay expansion.
6) Optional GPU path only if needed.
7) Hardening + release.

Source: `docs/10_v3_plan.md`

## 13) Planning Guidance for V3

When generating V3 plans, respect:
- V2 constraints on bundle size and perf invariants.
- V2 API contract semantics (time, gaps, ordering, multi-axis).
- Worker path opt-in and tree-shaking expectations.
- Pinned-machine perf baselines and CI policy.

## 14) Quick Command Index

```bash
npm run build
npm test
npm run test:playwright:smoke
npm run size
npm run perf:record
npm run perf:check
PERF_SKIP_COMPARE=1 npm run perf:check
```
