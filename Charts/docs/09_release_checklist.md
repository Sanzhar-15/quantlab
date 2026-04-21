# Release Checklist

This checklist is the minimum bar for any release candidate. It is designed to be
reproducible and enforced by CI.

## Must-pass gates

- `npm test`
- `npm run test:playwright:smoke`
- `npm run test:playwright -- tests/dashboard.spec.ts`
- `npm run size` (see `docs/07_bundle_size.md`)
- `npm run perf:check` on the pinned perf machine (see `docs/06_perf_baselines.md`) including scenarios A/B/C + D/E/F
- Visual snapshots updated when rendering changes (`npm run test:playwright -- tests/visual.spec.ts`) including pan-cache, live-mode, multi-pane, revisions

## Baselines

- Update baselines only when changes are intentional:
  - Run `npm run perf:record` on the pinned machine.
  - Commit new JSON under `perf/baselines/`.
  - Note the rationale in the release notes or PR description.

## API + docs

- `docs/01_api_spec.md` remains frozen (V1).
- `docs/04_v2_api_contract.md` updated if any V2 API behavior changes.
- `docs/05_getting_started.md` examples still compile and run.
- `docs/16_v5_contract.md` and `docs/17_v5_perf_gates.md` reviewed and aligned with release scope.
- `docs/20_v5_test_matrix.md`, `docs/21_migration_v4_to_v5.md`, and `docs/22_accessibility_notes.md` reviewed.
- Rollback strategy reviewed (`docs/23_rollback_plan.md`).

## Manual sanity

- Demo loads and tooltip works with `event.formattedTime`.
- Multi-axis demo uses left/right formatting without clipping.
- Worker path still tree-shakes when not imported.
- Deterministic export verified at DPR 1/2 and UTC/local (`packages/chart-render-canvas2d/src/export.test.ts`).
