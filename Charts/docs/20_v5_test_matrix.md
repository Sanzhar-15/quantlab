# V5 Test Matrix (V5.5 Audit)

This matrix documents current test coverage and highlights gaps to close during
V5.5 hardening. It is additive-only and does not remove any existing suites.

## Test matrix

| Layer | Scope | Existing suites | Notes |
| --- | --- | --- | --- |
| Unit | Core math, scales, data stores, LOD | `packages/chart-core/src/*test.ts` | Numeric scale, time/price scales, layout engine, LOD pyramid, decimators |
| Unit | Renderer helpers + workers | `packages/chart-render-canvas2d/src/*test.ts` | Crosshair, axis utils, histogram renderer, worker/LOD, pan cache, memory policy |
| Integration | Keyboard + UX | `packages/chart-render-canvas2d/src/keyboard.test.ts` | Focus + keyboard interactions baseline |
| Integration | Export determinism | `packages/chart-render-canvas2d/src/export.test.ts` | Hash-based deterministic PNG export |
| E2E (Playwright) | Smoke + invariants | `apps/perf-harness/tests/smoke.spec.ts`, `perf-invariants.spec.ts` | Overlay-only pointermove invariant |
| E2E (Playwright) | Interactions | `apps/perf-harness/tests/interactions.spec.ts` | Pan inertia, wheel anchor, crosshair modes |
| E2E (Playwright) | Visual regression | `apps/perf-harness/tests/visual.spec.ts` | Series types, multi-pane, pan cache, streaming, worker scenes |
| E2E (Playwright) | Perf + baselines | `apps/perf-harness/tests/perf.spec.ts` | Scenarios A–F with gates |
| E2E (Playwright) | Leak checks | `apps/perf-harness/tests/leak.spec.ts` | Memory leak guardrails |
| E2E (Playwright) | Export flow | `apps/perf-harness/tests/export.spec.ts` | End-to-end export coverage |

## Coverage map (V5.1–V5.4)

- Contracts + gates: `docs/16_v5_contract.md`, `docs/17_v5_perf_gates.md` (validated by perf harness + size checks).
- Perf + smoothness: pan cache, streaming, worker LOD, input coalescing covered by `perf.spec.ts`, `visual.spec.ts`, and unit tests.
- Series types: line/area/baseline/histogram/candlestick/bar covered by visual scenes; histogram has unit coverage.
- Multi-pane + sync: visual scenes `multi-pane`, `sync-multi-pane`.
- Crosshair modes: interaction tests cover nearest + interpolate.
- Themes + contrast: `theme.test.ts`, `theme-contrast.test.ts`, plus visual theme scenes.

## Gaps + required additions (V5.5)

- Fuzz/property tests for patch/revision pipelines, gap handling, and time-scale conversions (V5.5-03).
- Dashboard correctness tests for multi-chart scheduling + visibility (V5.5-04).
- Migration compatibility checklist and validation snippets for API parity (V5.5-05).
- Accessibility compliance audits beyond keyboard baseline (V5.5-06).
- Expanded visual regressions for specific UX regressions (drag stutter, scale jitter) (V5.5-02).
