# North Star

## Target use-case

Website-embedded financial/macro line charts:

- Often normalized (base-100, % change, z-score, rebased indices).
- Irregular timestamps (missing weekends/holidays, sparse macro releases, jitter).
- Multiple overlayed series with a single time axis.

## Rendering approach

- Canvas2D core with crisp-line priority (pixel-snapped strokes, DPI-correct rendering).
- Optional WebGL/WebGPU renderer later, but not required for v1.
- Layered rendering model: underlay (grid/axes), series, overlay (crosshair/hover) to minimize redraw work.

## Absolute goals + measurable gates

### Performance invariants

- No per-frame allocations proportional to data size.
- Pointermove should redraw overlay only (no series/grid/axis rerender).
- Rendering cost must scale approximately **O(viewport pixels)**, not **O(N points)**.

### Benchmarks (deterministic scenarios)

- **SCENARIO_A**: 3 series × 10k points irregular time.
- **SCENARIO_B**: 2 series × 200k points irregular time.
- **SCENARIO_C**: 1 series × 2M points irregular time (stress).

### CI gates

- Bundle-size budget enforced (gzipped) for `chart-core` + `chart-render-canvas2d`.
- Perf regression gate: compare against stored baseline JSON; fail if **> +15%** median frame time on any scenario.
- Memory leak smoke test: mount/unmount 50× without heap growth trend.

## Non-goals for v1

- Candlesticks / OHLC.
- Technical analysis (TA) tools and indicators.
- Drawing tools (trendlines, fibs, etc.).
- Complex annotations (rich text, collision-avoiding callouts, etc.).
