# V3 Implementation Plan (Optimized)

This plan is optimized for stability, predictable latency, and dashboard-scale performance while
preserving V1/V2 contracts and bundle budgets.

## Principles (Non-Negotiables)

- V1 API is frozen; V2 semantics must not regress.
- Worker rendering remains opt-in by import.
- Core + canvas2d bundle stays within 64 KB gzip hard cap (soft 61 KB).
- Improvements must be measurable in the perf harness.
- Prefer simple, robust mechanisms over high-risk complexity.

## V2 Reality Check (Do Not Regress)

- Layered rendering (underlay/series/overlay) with overlay-only pointermove.
- LOD + decimation bounded by plot width; no per-frame allocations proportional to data.
- Chunked data store + DataProvider with prefetch/backpressure and eviction.
- Optional worker path via import; tree-shaking intact.
- Perf and bundle gates enforced in CI on pinned hardware.

## Current Measurements (Local, Informational)

Bundle sizes:
- core 10.8 KiB gzip; canvas2d 21.8 KiB gzip; total 32.6 KiB gzip.
- optional workers 2.4 KiB gzip.

Perf scenarios (A/B/C):
- A: frame median 16.7 ms, p95 16.8 ms; pointer p95 0.7 ms; long tasks 0.
- B: frame median 16.7 ms, p95 16.7 ms; pointer p95 1.9 ms; long tasks 0.
- C: frame median 16.7 ms, p95 33.4 ms; pointer p95 0.9 ms; long tasks 1 (56 ms).

Bottlenecks to focus on:
- SCENARIO_C frame-time tail.
- SCENARIO_C long task tail.
- SCENARIO_C wheel latency tail.

## V3 Definition of Done (Measurable Gates)

### New Scenarios

- SCENARIO_D: 10 series x 2,000,000 points; mixed left/right axes; irregular timestamps.
- SCENARIO_E: streaming ingest 10,000 points/sec in bursty batches for 60s with live auto-scroll.
- SCENARIO_F: dashboard page with 12 charts (4 visible, 8 offscreen) and shared runtime.

### Pass/Fail Targets

Frame times (median/p95):
- A/B: <= 16.7 ms / 20 ms
- C: <= 16.7 ms / 25 ms
- D: <= 16.7 ms / 28 ms

Input latency p95:
- pointermove <= 6 ms
- drag <= 10 ms
- wheel <= 20 ms

Counters:
- pointermove must remain overlay-only (no series/grid/axis invalidation).
- offscreen charts must not render while idle (Scenario F).

Bundle size:
- core + canvas2d <= 64 KB gzip (hard cap).

## Optimized PR Sequence (12 PRs)

Each PR is additive-only and must respect V1/V2 contracts.

### PR 1 — V3 Contract + Perf Gates D/E/F + Instrumentation

Goal:
- Lock V3 contract and make new improvements measurable.

Deliverables:
- Add docs: `docs/12_v3_contract.md`, `docs/13_v3_perf_gates.md`.
- Extend perf harness with scenarios D/E/F.
- Add counters: per-layer rerenders, per-chart RAF participation, worker queue depth.

Tests:
- Update perf tests in `apps/perf-harness/tests/perf.spec.ts`.

Perf:
- Run A/B/C + D/E/F (informational until pinned baselines exist).

Compatibility:
- No API changes; instrumentation-only.

### PR 2 — ChartRuntime v3 (Single RAF + Visibility Culling)

Goal:
- Dashboard scaling without N schedulers.

Deliverables:
- Introduce runtime scheduler (single RAF) that services all mounted charts.
- Add `IntersectionObserver` visibility culling (offscreen charts pause renders).
- Ensure worker path remains opt-in by import.

Tests:
- Add runtime unit tests.
- Scenario F: assert offscreen charts stop rendering.

Perf:
- Run Scenario F + A/B (no regression).

Compatibility:
- Additive-only; default runtime is singleton.

### PR 3 — Batch API + Streaming Coalescing

Goal:
- Prevent render storms for streaming.

Deliverables:
- Add `chart.batch(fn)` to coalesce invalidations.
- Add `series.appendBatch(points)` for bulk ingestion.
- DataProvider queue can emit batches without breaking existing updates.

Tests:
- Unit tests for batching in `packages/chart-core/src/data-store.test.ts`.

Perf:
- Run Scenario E; expect <= 1 render/frame per chart.

Compatibility:
- Additive-only; no semantic changes.

### PR 4 — Revisions/Backfills (patchExisting + Dirty Range)

Goal:
- Efficient macro data revisions without full rebuilds.

Deliverables:
- Add `series.patchExisting(points)` (replace values where timestamps exist).
- Track dirty ranges to limit LOD/decimator recomputation.
- For DataProvider, patch triggers range refetch if configured (no new update type required).

Tests:
- Patch tests for gaps and crosshair in `packages/chart-render-canvas2d/src/crosshair.test.ts`.

Perf:
- Scenario D/E; patching small windows does not rebuild full LOD.

Compatibility:
- Additive-only; no V2 contract changes.

### PR 5 — Incremental LOD Updates

Goal:
- Make LOD updates streaming-friendly.

Deliverables:
- Update `packages/chart-core/src/lod-pyramid.ts` to update only affected buckets on append/update/patch.
- Add per-frame LOD work counters.

Tests:
- Incremental LOD tests in `packages/chart-core/src/lod-pyramid.test.ts`.

Perf:
- Scenario E; avoid LOD rebuild spikes.

Compatibility:
- Internal-only changes.

### PR 6 — PanCache Overscan + Live Auto-Scroll

Goal:
- Smooth pan and live mode without edge-strip repaint.

Deliverables:
- Add PanCache (overscan buffer + integer DPR shift) for series layer.
- Add auto-scroll option that reuses PanCache for live updates.
- Freeze autoscale during active drag; optional tick freeze for stability.

Tests:
- Visual regression for pan shifting and live mode.

Perf:
- Scenario D/E; lower p95 during pan and live ingest.

Compatibility:
- Feature flag; default behavior unchanged.

### PR 7 — Multi-Pane Layout

Goal:
- Multi-pane charts with shared time scale.

Deliverables:
- Layout engine supports stacked panes with per-pane axes.
- Add `chart.addPane()` with pane IDs; series can target a pane.

Tests:
- Layout tests in `packages/chart-core/src/layout-engine.test.ts`.

Perf:
- Scenario D; single-pane baselines unchanged.

Compatibility:
- Additive-only.

### PR 8 — Multi-Pane Interactions + Crosshair Semantics

Goal:
- Clear crosshair behavior across panes.

Deliverables:
- Vertical crosshair spans panes; horizontal line only in active pane.
- Add optional `paneId` to crosshair event (additive).

Tests:
- Crosshair tests in `packages/chart-render-canvas2d/src/crosshair.test.ts`.

Perf:
- Scenario D; overlay-only invariant maintained.

Compatibility:
- Additive-only.

### PR 9 — Sync Groups (Multi-Chart)

Goal:
- Dashboard-grade synchronization without render storms.

Deliverables:
- Add `createSyncGroup()` to sync time range + crosshair.
- Throttle and batch sync updates through ChartRuntime.

Tests:
- Sync unit tests in `packages/chart-render-canvas2d/src/index.test.ts`.

Perf:
- Scenario F; no feedback loops or N x renders.

Compatibility:
- Additive-only.

### PR 10 — Macro Time Ticks + Series Semantics

Goal:
- Financial credibility for macro timelines.

Deliverables:
- Calendar-aligned time ticks with stable selection under pan/zoom.
- Series options: `renderMode: 'linear' | 'step'`, `sampleMode: 'nearest' | 'linear' | 'hold'`.
- Chart option: `gapThresholdMs` to break lines on large gaps.

Tests:
- Time tick stability tests in `packages/chart-core/src/time-scale.test.ts`.
- Sampling mode tests in `packages/chart-render-canvas2d/src/crosshair.test.ts`.

Perf:
- Scenario A/B; no layout thrash or size regressions.

Compatibility:
- Additive-only; defaults preserve V2 behavior.

### PR 11 — Long-History Compaction (LOD-Only Retention)

Goal:
- Bounded memory with accurate zoomed-out views.

Deliverables:
- Retain raw data only within `rawRetentionMs` of visible window.
- Keep LOD-only outside retention; rehydrate via DataProvider when zoomed.

Tests:
- Compaction tests in `packages/chart-core/src/chunked-data-store.test.ts`.

Perf:
- Scenario D/E; memory remains bounded.

Compatibility:
- Optional feature; default off.

### PR 12 — Hardening + Release Readiness

Goal:
- Lock in V3 gains and prevent regressions.

Deliverables:
- Visual regression scenes for pan cache, live mode, multi-pane, revisions.
- Fuzz tests for patchExisting + gaps + sampling modes.
- Dashboard correctness test for offscreen render counts.
- Update release checklist for V3 gates.

Tests:
- Update `apps/perf-harness/tests/visual.spec.ts` and add fuzz tests in chart-core.

Perf:
- Run full A/B/C + D/E/F with pinned baselines.

Compatibility:
- No API changes.

## Risk Register (Top 5)

1) Streaming regressions (render storms or LOD spikes).
   - Mitigation: batching + incremental LOD, feature flags; rollback to V2 ingestion.
2) PanCache artifacts (blurring/seams).
   - Mitigation: integer DPR shifts, periodic full redraw, feature flag default off.
3) Multi-pane complexity (layout/crosshair bugs).
   - Mitigation: isolate single-pane path, add targeted tests, staged rollout.
4) Perf flakiness across machines.
   - Mitigation: pinned perf baselines; local comparisons optional.
5) Bundle creep.
   - Mitigation: size gate in every PR; trim optional features.

## Non-Goals (Move to V4)

- GPU renderer (WebGL/WebGPU).
- Shared worker pool unless Scenario F proves necessary after runtime work.
- Edge-strip repaint or adaptive quality manager.
- TA/drawing tools, candlesticks/OHLC, mobile-first UI.

## Why V3 Is a Step-Change Over V2

- Dashboard-grade runtime (single RAF + visibility culling).
- Streaming-first pipeline with batching and incremental LOD.
- Macro revisions handled without full rebuilds.
- Pan/live feel materially smoother (PanCache overscan).
- Multi-pane and sync groups for institutional workflows.
- Macro time ticks + step/hold semantics increase financial credibility.
- Long-history compaction keeps memory flat with accurate overview.
- New scenarios D/E/F enforce these gains in CI.
