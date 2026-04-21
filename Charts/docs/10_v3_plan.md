# V3 Plan (North Star + Execution)

## Vision

Deliver the fastest, most responsive line-charting engine for macro/finance data on PC/laptop,
with a distinct visual identity and a developer-first API. V3 should feel instant at any scale,
support real-time streams, and remain small and composable.

## Non-negotiables

- PC/laptop only (no mobile optimizations).
- Rendering cost stays ~O(plotWidth), never O(total points).
- No per-frame allocations proportional to data size.
- Bundle size remains within current caps (core + canvas2d soft 61 KB / hard 64 KB gzip).
- WebGL/WebGPU remains optional and off by default.

## V3 Differentiators (beyond V2)

- Real-time streams at high throughput (10k+ points/s) without UI stalls.
- Multi-pane layouts (stacked charts with synchronized time scale).
- Data virtualization with compression to keep "infinite" history viable.
- Rich, low-cost overlays: bands, events, ranges, alerts, custom annotations.
- Visual identity that is unmistakably Charts+ (typography, grid rhythm, color system).

## Target Metrics

### Interaction latency (p95)

- Pointermove: < 8 ms
- Wheel zoom: < 20 ms
- Drag pan: < 18 ms

### Frame times (median/p95)

- SCENARIO_A (3 x 10k): < 6 / 12 ms
- SCENARIO_B (2 x 200k): < 10 / 20 ms
- SCENARIO_C (1 x 2M): < 14 / 28 ms
- SCENARIO_D (10 x 2M, mixed axes): < 18 / 33 ms
- SCENARIO_E (streaming 10k pts/s): no long tasks > 50 ms

### Memory (working set)

- SCENARIO_B: <= 200 MB
- SCENARIO_C: <= 400 MB
- SCENARIO_D: <= 600 MB

## Execution Plan

### Phase 0: V3 Contract + Benchmarks

Deliverables:
- Lock V3 API deltas (multi-pane, streaming controls, overlay APIs).
- Define new perf scenarios D/E and baseline datasets.
- Update perf harness to record stream throughput + jitter.

Acceptance:
- New scenarios and baselines documented and runnable.
- V3 contract documented in a single spec.

### Phase 1: Data Pipeline v2 (Virtualization + Compression)

Deliverables:
- Chunk store supports delta encoding + optional quantization (lossless by default).
- Background compaction for long history (older chunks compressed).
- Streaming ring buffer with stable backpressure and drop/coalesce policy.

Acceptance:
- Sustained 10k pts/s streaming with bounded memory growth.
- Visible window always retained with padding under eviction.

### Phase 2: Rendering Pipeline v2 (Multi-pane + Layering)

Deliverables:
- Multi-pane layout engine with shared time scale and independent axes.
- Per-pane series layers; overlay layer supports crosshair + annotations.
- Fast reuse on small pans (raster shift) with safe invalidation.

Acceptance:
- Multi-pane demo with synced zoom/pan.
- Pointermove stays overlay-only across panes.

### Phase 3: Interaction & UX Upgrade

Deliverables:
- Precision zoom (cursor-anchored), inertial pan improvements.
- Predictable crosshair on gaps with configurable modes.
- Tooltip alignment upgrade (jitter-free, no overflow).

Acceptance:
- Interaction latency targets met in perf harness.
- Visual regression stable across themes and panes.

### Phase 4: Extensibility (Plugins + Overlays)

Deliverables:
- Expanded plugin hooks: hit-testing, render order, state lifecycle.
- First-party overlay pack (bands, markers, ranges, alerts, labels).
- Safety rails: plugin render budgets + clipping enforced.

Acceptance:
- Plugins do not trigger extra series renders on pointermove.
- Example plugin suite in demo with perf invariants passing.

### Phase 5: Optional GPU Path (Only if needed)

Deliverables:
- Evaluate OffscreenCanvas worker + compute-only worker upgrades.
- Prototype GPU line renderer only if CPU path misses targets.

Acceptance:
- GPU path gated behind build flag and tree-shakable.
- Clear perf win without bundle size creep.

### Phase 6: Hardening + Release

Deliverables:
- Fuzz/property tests for streaming + compression + LOD edges.
- Snapshot suite for multi-pane + overlay-heavy scenes.
- Release checklist updated for V3.

Acceptance:
- All CI gates pass with pinned baseline runs.
- Docs updated with V3 changes and migration notes.

## Risks and Mitigations

- Streaming + compression complexity: keep lossless path as default.
- Multi-pane layout cost: cache axis metrics and reuse across frames.
- Plugin overhead: enforce render budgets and coalesce updates.
- Perf flakiness: pinned machine baselines + input-latency slack.

## Out of Scope (V3)

- Full TA tool suite and drawing tools.
- Candlesticks or OHLC.
- Mobile-first UI.
