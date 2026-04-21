# Observability, Performance, and Testing (V3)
**Goal:** keep the renderer fast and stable over time with continuous measurement.

---

## 1) Runtime metrics (sampled)
- frame time histogram (median, p95, p99)
- interaction-only frame time (crosshair pass cost)
- input-to-photon estimate (timestamp pointer + render)
- tile cache:
  - hit rate
  - rebuild queue length
  - rebuild time
- atlas:
  - page count
  - churn rate
- device loss:
  - count
  - recovery time
- errors:
  - scoped errors
  - uncaptured errors
- budgets:
  - tiles/atlas/buffers used vs caps

---

## 2) Tracing hooks
Add tracing spans:
- `frame.begin`
- `input.apply`
- `tiles.reproject`
- `tiles.build`
- `render.series`
- `render.text`
- `render.overlay`
- `present`

Allow exporting traces to JSON for offline analysis.

---

## 3) Perf harness (deterministic)
Scenes:
- 1k / 10k / 100k candles visible
- 50 drawings
- 100 markers
- streaming ticks at 50–200/sec bursts

Run on:
- desktop iGPU and dGPU
- mid-tier mobile
- Safari + Chromium

Gate conditions:
- crosshair p99 < threshold
- pan p95 stable
- no memory growth trend over 30-min soak

---

## 4) Visual golden tests
Render canonical scenes to offscreen target:
- multiple zoom levels
- slow pan
- theme changes

Compare images with tolerances:
- pixel snapping correctness
- AA stability
- label jitter

---

## 5) CI regression gates
- perf suite nightly on representative devices (or cloud device lab)
- unit tests on transforms, LOD, layout
- integration tests for tier downgrade behavior

---

## 6) Debug overlays (dev build)
- show FPS & frame time
- show tile states overlay
- show cache memory usage
- show chosen tier and quality profile
