# Current State (V5.1 Snapshot)

This document is a single-source snapshot for V5 planning. It summarizes what exists,
where the core entry points live, and which gates are enforced.

## Status

- V2 implementation is complete per `docs/03_v2_plan.md`.
- V4 contract + perf gates are defined (`docs/14_v4_contract.md`, `docs/15_v4_perf_gates.md`).
- V5.1 contract + perf gates are defined (`docs/16_v5_contract.md`, `docs/17_v5_perf_gates.md`).
- Optional WebGL backend is intentionally not built.
- Worker path (LOD + OffscreenCanvas series layer) is implemented and gated by import.

## API + Contracts

- V1 API spec: `docs/01_api_spec.md`
- V2 API contract: `docs/04_v2_api_contract.md`
  - Time zone affects formatting only (default `utc`).
  - DataProvider + chunked storage options (prefetch, backpressure, maxChunks/maxBytes).
  - Gap and crosshair semantics (nearest vs interpolate).
- V4 contract + perf gates: `docs/14_v4_contract.md`, `docs/15_v4_perf_gates.md`
- V5.1 contract + perf gates: `docs/16_v5_contract.md`, `docs/17_v5_perf_gates.md`
- Getting started + migration: `docs/05_getting_started.md`, `docs/08_migration_v1_to_v2.md`
- Series API additions: area/baseline/histogram/candlestick/bar + custom series renderer.
- Markers + watermark are supported via `setMarkers`/`setWatermark`.

## Architecture + Pipeline

- Core architecture: `docs/02_architecture.md`
- Core types/entry: `packages/chart-core/src/api.ts`, `packages/chart-core/src/index.ts`
- Data:
  - `packages/chart-core/src/data-store.ts`
  - `packages/chart-core/src/chunked-data-store.ts`
  - `packages/chart-core/src/data-provider.ts`
- Scales + layout:
  - `packages/chart-core/src/time-scale.ts`
  - `packages/chart-core/src/price-scale.ts`
  - `packages/chart-core/src/layout-engine.ts`
- Performance primitives:
  - `packages/chart-core/src/frame-scheduler.ts`
  - `packages/chart-core/src/line-decimator.ts`
  - `packages/chart-core/src/lod-pyramid.ts`

## Renderer + UX

- Canvas renderer entry: `packages/chart-render-canvas2d/src/index.ts`
- Surfaces + DPR snapping: `packages/chart-render-canvas2d/src/canvas-surface.ts`
- Worker entry: `packages/chart-render-canvas2d/src/worker.ts`
- Numeric X chart factories: yield curve + options (see `createYieldCurveChart`, `createOptionsChart`)
- Plugin hooks + examples: `apps/demo/src/plugins.ts`
- Demo entry + tooltip logic: `apps/demo/src/main.ts`
- Motion policy + timings: `docs/18_motion_policy.md`
- Theme packs + usage: `docs/19_theme_packs.md`

## Perf Harness + Baselines

- Harness app: `apps/perf-harness/src/main.ts`
- Perf tests + gating: `apps/perf-harness/tests/perf.spec.ts`
- Baselines: `perf/baselines/<browser>/<library>/`
- Results output: `perf/results/<browser>/<library>/`
- Baseline policy: `docs/06_perf_baselines.md`

## Size Budgets + CI Gates

- Budgets: `config/bundle-budgets.json`
- Size report script: `scripts/bundle-size.mjs`
- Release gates: `docs/09_release_checklist.md`
- CI workflows: `.github/workflows/ci.yml`, `.github/workflows/perf.yml`

## Known Notes

- Last-value marker pills render on the series axis side (left for default).
- Series markers and price lines render in the overlay layer (main thread), even when series rendering uses workers.
- Worker path is enabled by importing `@charts-plus/chart-render-canvas2d/worker`.
- Custom series are rendered on the main thread; worker mode is skipped when custom series are visible.
- Input latency sampling is RAF-based and clamped to >= 0.
- Perf compare can be skipped locally: `PERF_SKIP_COMPARE=1 npm run perf:check`
- Axis options support `autoScalePadding` for controlled headroom on autoscale ranges.
- Pan options support `axisSmoothing` to tune scale damping behavior.
- Price scales support `mode: 'percentage' | 'indexedTo100'` (baseline = first visible value on axis).
- Pointermove should remain overlay-only for perf invariants.
