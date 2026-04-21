# Perf baselines and CI policy

This project uses stored perf baselines to catch regressions and compare against TradingView.

## Baseline rules

- Baselines are keyed by browser and library under `perf/baselines/<browser>/<library>/`.
- Record baselines on a stable, pinned machine class (ideally a dedicated runner).
- Do not update baselines to hide regressions; only update when changes are expected.

## How to record baselines

1) Ensure local environment is stable (close extra apps, fixed power mode).
2) Run:

```bash
npm run perf:record
```

3) Commit the new JSON files under `perf/baselines/`.

For local dry runs without gating comparisons, you can skip baseline checks:

```bash
PERF_SKIP_COMPARE=1 npm run perf:check
```

## CI policy

- PRs run smoke + perf invariants only (no heavy perf).
- Heavy perf comparisons run on a scheduled workflow or a pinned runner.
- If perf JSON shape changes, re-record baselines before merging.

## When to update baselines

- After intentional performance tradeoffs (documented in PR).
- After major runtime or tooling upgrades (Node, browser, Playwright).
- After changes to scenario generators or interaction scripts.
