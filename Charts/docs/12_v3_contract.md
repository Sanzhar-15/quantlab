# V3 Contract

This contract defines V3 scope, compatibility constraints, and the minimum instrumentation required
to measure V3 improvements safely.

## Scope + Compatibility

- V1 API is frozen; V2 semantics must not regress (monotonic time, null gaps, worker opt-in).
- All V3 changes are additive-only; no breaking changes to public APIs.
- Worker rendering remains opt-in by import (no implicit worker creation).

## Bundle + Perf Constraints

- Core + canvas2d bundle budget remains at 61 KB gzip (soft) / 64 KB gzip (hard).
- Performance gates are enforced through the perf harness (see `docs/13_v3_perf_gates.md`).

## Instrumentation Contract

Debug API extensions (non-public):

- `readRenderStats(reset?)` returns:
  - `frames` (RAF participation), `layout`, `series`, `overlay`
  - `underlay` (alias of layout), `raf` (alias of frames)
- `readWorkerStats(reset?)` returns:
  - `lod`: `{ queueDepth, totalMs, completed }`
  - `chunkLod`: `{ queueDepth, totalMs, completed }`

Perf harness additions:

- RAF-based input latency sampling (existing).
- Optional EventTiming input latency column when supported by the browser.

## V3 Scenarios (Perf Harness)

- SCENARIO_D: 10 series x 2,000,000 points, mixed left/right axes, irregular timestamps.
- SCENARIO_E: streaming ingest 10,000 points/sec in bursty batches for 60s with live auto-scroll.
- SCENARIO_F: dashboard with 12 charts, only 4 visible at once.

## Invariants (Must Hold)

- Pointermove remains overlay-only (no series/layout invalidations).
- Offscreen charts should not render while idle (Scenario F).
- Worker opt-in by import remains intact.
