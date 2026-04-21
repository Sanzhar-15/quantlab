# Rollback Plan (V5)

This plan documents safe rollback levers without breaking API compatibility.

## Feature toggles

- Worker rendering:
  - Remove the worker import or set `seriesRenderer: 'main'`.
- Pan cache / overscan:
  - Set `interaction.pan.overscanRatio = 0` to disable pan cache.
  - Set `interaction.pan.freezeAxis = true` to stabilize axis during drag.
- Inertia:
  - Set `interaction.inertia.enabled = false`.
- Elastic bounds:
  - Set `timeScale.elasticClamp = false` and `timeScale.clampToData = false`.
- Streaming compaction:
  - Remove `rawRetentionMs` and `memory` settings to keep full raw history.

## Rollback steps

1) Disable worker rendering in the entrypoint (remove `@charts-plus/chart-render-canvas2d/worker` import).
2) Apply conservative interaction defaults (`inertia.enabled = false`, `pan.overscanRatio = 0`).
3) Revert to last known-good build artifacts if needed.

## Verification after rollback

- `npm test`
- `npm run test:playwright:smoke`
- `npm run size`
- `npm run perf:check` on pinned perf hardware
