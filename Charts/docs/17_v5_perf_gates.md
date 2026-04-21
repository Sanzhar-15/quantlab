# V5 Perf Gates

These gates define pass/fail thresholds for V5.1. All metrics are captured by the perf harness
and must be reproducible on pinned hardware before CI baselines are recorded.

## Scenarios

- SCENARIO_A: 3 series x 10k points (irregular timestamps, gaps).
- SCENARIO_B: 2 series x 200k points.
- SCENARIO_C: 1 series x 2M points.
- SCENARIO_D: 10 series x 2M points, mixed axes, irregular timestamps.
- SCENARIO_E: streaming ingest 10k points/sec for 60s with auto-scroll.
- SCENARIO_F: 12 charts on one page, only 4 visible.

## Interaction Script (Perf Harness)

- Pointer sweep across plot.
- Wheel zoom in/out.
- Drag pan.
- For SCENARIO_E, streaming runs concurrently with interactions.

## Targets (Median / P95)

Frame time:

- A/B: <= 16.7 ms / 20 ms
- C: <= 16.7 ms / 25 ms
- D: <= 16.7 ms / 28 ms

Input latency p95:

- pointermove <= 6 ms
- drag <= 10 ms
- wheel <= 20 ms

## Memory + Sampling

- Capture memory samples at start, mid, and end of each scenario.
- Heap/working-set growth must remain bounded (no monotonic growth after warm-up).
- Soft caps (p95 working-set):
  - A/B/C: <= 250 MB
  - D/E: <= 600 MB
  - F: <= 350 MB

## LOD + Worker Constraints

- No sustained LOD rebuild spikes during pan/zoom or streaming.
- LOD work per frame should remain bounded (no spikes > 30 ms).
- Worker queue depth must converge during steady-state runs.

## Invariants (Counters)

- Pointermove stays overlay-only (`series` and `layout/underlay` counts remain 0).
- Offscreen charts do not render while idle (Scenario F).
- Worker queue depth remains bounded; total worker time must not grow unbounded over a run.
- Allocation stats should remain bounded (no per-frame growth over time).

## Bundle Gate

- Core + canvas2d <= 64 KB gzip (hard cap).

## Notes

- Use `PERF_SKIP_COMPARE=1` for local runs without baselines.
- Record new baselines on pinned hardware before enabling CI comparisons for D/E/F.
