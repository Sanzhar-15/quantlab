# V2 Plan (Competitive, PC/Laptop Focused)

## Goals

Beat TradingView Lightweight Charts for **line-only financial/macro charts** on PC/laptop by:

- Lower interaction latency (input-to-paint).
- Stable frame times at high data volume.
- Comparable or smaller bundle size.
- Better UX for gaps, overlays, and theme polish.

## Constraints (Hard Targets)

### Devices

- PC/laptop only.
- Baseline target: 4+ core CPU, 16 GB RAM, integrated GPU OK.

### Data scale

- No explicit point limit.
- Working set bounded by visible window + bounded caches; old chunks must be evictable.
- Rendering cost must be O(visible points / pixels), not O(total points).

### Bundle size (gzip, core + canvas2d)

- Soft cap: 61 KB.
- Hard cap: 64 KB.
- Optional Worker/WebGL paths must be tree-shakable and off by default; when enabled, +10 KB max.

## Measurement Protocol

- Fixed random seeds and identical datasets/interactions across libraries.
- Warm-up pass excluded; collect >= 5s of samples per scenario.
- Record median and p95 for input-to-paint and frame times; track long tasks.
- Store metadata (browser version, OS, CPU class, DPR) with baselines.
- Heavy perf gates run on scheduled CI with pinned hardware; PRs run smoke + perf invariants only.
- See docs/06_perf_baselines.md for baseline rules and CI policy.

## Definition of "Beat TradingView"

### Interaction latency (p95)

- Pointermove -> overlay render: < 12 ms
- Wheel zoom -> first render: < 30 ms
- Drag pan -> frame gap: < 25 ms

### Frame times (median/p95)

- SCENARIO_A (3 x 10k): < 8 ms / 16 ms
- SCENARIO_B (2 x 200k): < 12 ms / 25 ms
- SCENARIO_C (1 x 2M): < 16 ms / 33 ms

### Memory (working set)

- SCENARIO_B: <= 200 MB
- SCENARIO_C: <= 400 MB
- Old data must be discardable or pageable; rendering depends on visible window only.

### Bundle size

- <= 61 KB gzip preferred; <= 64 KB hard stop (core + canvas2d).

### Visual quality

- Gaps preserved.
- Spike preservation verified (min/max envelope).
- Crisp 1px strokes at DPR 1/1.5/2.

## Execution Plan (Optimized Order)

### Phase 0: Instrumentation + Competitor Harness

**Why:** We need defensible evidence and hard go/no-go gates.

Deliverables:

- Input-to-paint timing for pointermove, wheel, drag.
- Long task sampling + memory snapshots.
- Baselines keyed by browser + machine metadata.
- CI gate: fail if our median/p95 regresses > 15% or if worse than TradingView in any scenario.

Acceptance:

- Local command produces JSON for both libs with metadata.
- CI compares against baselines and fails on regressions.

### Phase 0.5: Product/API Contract + Visual Direction

**Why:** Prevent mid-build rework and keep UX coherent.

Deliverables:

- API contract decisions: timezone handling, value formatting hooks, streaming semantics, gap/crosshair behavior.
- Multi-axis mapping contract (per-series axis ownership).
- Visual identity spec: typography, grid hierarchy, color system, overlay styling.
- Update docs with the above decisions and a small design demo.

Acceptance:

- API behaviors are documented and stable before heavy implementation.
- Demo reflects the signature look and feels non-generic.

### Phase 1: Data Virtualization + Memory Policy

**Why:** Unlimited data scale requires a bounded working set.

Deliverables:

- DataProvider interface (range fetch + streaming append).
- Chunked columnar store with ring-buffer mode + prefetch window.
- Per-chunk stats (min/max/variance, gap count) for autoscale and LOD.
- Eviction policy (LRU or visibility-based) with explicit cache budgets and backpressure.

Acceptance:

- SCENARIO_C remains interactive while evicting old chunks.
- Working set stays <= 2x visible window.

### Phase 2: Multi-Resolution LOD + Decimation

**Why:** Keep render cost ~O(plotWidth) across all zoom levels.

Deliverables:

- LOD pyramid per chunk (min/max + first/last + gaps).
- Adaptive level selection by pixels-per-sample.
- Bounded decimation buffers and cache reuse (no per-frame allocations).

Acceptance:

- Pan/zoom cost scales with plot width, not total points.
- Output size bounded by k * plotWidth.

### Phase 3: Worker LOD Pipeline

**Why:** Build heavy LOD without blocking the UI.

Deliverables:

- LOD build in Worker using Transferable arrays.
- Progressive updates (coarse first, refine later).
- Optional SharedArrayBuffer path when COOP/COEP is available.
- Fallback to main thread chunking when Worker unavailable.

Acceptance:

- Loading SCENARIO_C does not block the UI thread for long tasks.
- Time-to-first-render stays low via coarse LOD.

### Phase 4: OffscreenCanvas Series Rendering

**Why:** Move the heavy series draw off the main thread.

Deliverables:

- Series layer rendered in Worker via OffscreenCanvas.
- Main thread renders layout, axes, overlay only.
- Minimal message protocol (visible range, theme hash, cache key) with shared buffers when possible.
- Early spike test compares OffscreenCanvas vs main-thread series path; keep a fallback toggle.

Acceptance:

- Pointermove stays overlay-only and < 12 ms p95.
- SCENARIO_B/C meet frame-time targets.

### Phase 5: Interaction + UX + Multi-axis

Deliverables:

- Inertial pan, precise zoom anchor, consistent touch parity.
- Multi-axis support (left/right) with per-series axis mapping.
- Predictable crosshair snapping and improved tooltip alignment.

Acceptance:

- Interaction latency targets met without visual jitter.
- Multi-axis demo and tests pass.

### Phase 6: Optional WebGL Backend

**Only if Phase 4 cannot hit targets.**

Deliverables:

- WebGL line renderer prototype.
- Canvas2D fallback for text/axes.
- Tree-shakable build option with strict size budget.

Acceptance:

- Clear, measurable performance win vs Worker 2D.
- Bundle size remains within hard cap.

### Phase 7: DevEx + Release Readiness

Deliverables:

- Getting-started and migration notes for V2 API changes.
- Versioning and release checklist (perf/bundle gates + baseline update rules).
- Example integrations (basic, streaming, multi-axis).

Acceptance:

- Docs provide a stable, minimal onboarding path.
- Release checklist is reproducible and enforced.

## CI Gates (V2)

- Bundle size budget (soft/hard).
- Perf regressions (median/p95 + input-to-paint) vs baseline and vs TradingView.
- Memory trend checks (heap + working set).
- Visual regression (light/dark + gaps + annotations + multi-axis).
- Fuzz tests for time scale, gaps, binary search, LOD boundaries.
- Perf invariants (overlay-only on pointermove, decimator output bound).
- Scheduled CI runs heavy perf suite on pinned hardware; PR CI runs smoke + invariants.

## Non-Goals for V2

- Full TA/drawing tools.
- Candlesticks.
- Complex annotation collisions.

## Risk Register (Top 4)

1) Worker/OffscreenCanvas support and messaging overhead.
   - Mitigation: fallback to main thread, keep messages minimal.
2) Memory blowups with unlimited data.
   - Mitigation: chunk policy + explicit cache budgets + eviction.
3) Benchmark bias vs TradingView.
   - Mitigation: identical datasets/interactions, fixed seeds, metadata gating.
4) Bundle size creep.
   - Mitigation: hard budgets, tree-shaking, optional backends.
