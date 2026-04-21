# Quantlab Phase 2 Workbench Patches

Status: Draft
Owner: Quantlab PM/Eng

Purpose: Track all fork-level changes required to implement Phase 2 (Window Chrome, Activity Bar, History). Keep this list current with file paths and rationale.

## Patch Checklist

- [x] `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`
  - Add Quantlab market container (symbol/timeframe) in center-right cluster.
  - Add Quantlab history container (history button + badge) in right cluster.
  - Wire button clicks to `quantlab.selectSymbol`, `quantlab.selectTimeframe`, `quantlab.toggleHistoryDropdown`.
  - Register `quantlab.updateTitlebarState` to update labels/badge idempotently.
- [x] `src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css`
  - Style containers, buttons, hover/focus, and badge.
- [x] `src/vs/workbench/browser/parts/activitybar/media/activitybarpart.css`
  - Visual separator for Quantlab Activity Bar items.
- [x] `src/vs/workbench/browser/parts/compositeBarActions.ts`
  - Add `data-view-container-id` attributes for Activity Bar separators.

## Notes
- Extension provides a status bar fallback in unpatched builds.
- Update this file if additional patch points are discovered during implementation.
