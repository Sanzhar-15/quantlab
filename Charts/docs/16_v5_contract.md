# V5 Contract

This contract defines V5.1 scope, compatibility constraints, and required instrumentation to ship
V5 safely.

## Scope + Compatibility

- V1 API is frozen; V2 semantics must not regress (monotonic time, null gaps, worker opt-in).
- V5.1 changes are additive-only; no breaking changes to public APIs.
- Worker rendering remains opt-in by import (no implicit worker creation).
- Time/price scale behaviors remain stable unless explicitly called out in additive options.

## Bundle + Perf Constraints

- Core + canvas2d bundle budget remains 61 KB gzip (soft) / 64 KB gzip (hard).
- Optional worker bundle remains 8 KB gzip (soft) / 10 KB gzip (hard).
- Performance gates are enforced through the perf harness (see `docs/17_v5_perf_gates.md`).

## Data Integrity Rules

- `setData` requires strictly increasing time values.
- `append` requires `t > lastTime`; `updateLast` allows `t >= lastTime`.
- Out-of-order inputs follow the existing policy (`reject` or `drop`).
- `null` values remain gaps (stored as NaN); NaN/Infinity inputs are rejected.
- Formatting and axis layout must never depend on local time unless explicitly configured.

## Deterministic Export

- PNG export must be deterministic across runs given the same data + options.
- Default time zone remains `utc` for determinism; `local` is opt-in.
- Export must use a fixed font fallback order when system fonts differ.

## Instrumentation Contract

Debug API extensions (non-public, additive-only):

- `readRenderStats(reset?)` remains stable and gains optional fields as needed.
- `readWorkerStats(reset?)` remains stable and gains optional fields as needed.
- Memory sampling and LOD work stats are additive and optional.

Perf harness additions:

- RAF-based input latency sampling remains the primary metric.
- Optional EventTiming input latency column when supported.
- Optional memory/working-set sampling in perf output.

## Invariants (Must Hold)

- Pointermove remains overlay-only (no series/layout invalidations).
- Offscreen charts should not render while idle (Scenario F).
- Worker opt-in by import remains intact.
- No full LOD rebuilds on streaming appends or updateLast paths.
- Accessibility baseline: focusable chart container with ARIA label and keyboard pan/zoom/crosshair.
