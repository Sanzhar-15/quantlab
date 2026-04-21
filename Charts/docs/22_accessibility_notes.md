# Accessibility + UX Compliance (V5.5)

This document summarizes the V5 accessibility baseline and known tradeoffs.

## Baseline checks

- Focus + keyboard controls:
  - Chart container is focusable (`tabindex=0`) with `role="region"`.
  - Default `aria-label` applied if not provided.
  - Keyboard pan/zoom/crosshair toggles are covered by tests.
- Contrast checks:
  - Axis text, grid, tooltip, and focus band contrast are validated in tests.

## Relevant tests

- `packages/chart-render-canvas2d/src/accessibility.test.ts`
- `packages/chart-render-canvas2d/src/keyboard.test.ts`
- `packages/chart-core/src/theme-contrast.test.ts`

## Recommended usage

- Provide a meaningful `aria-label` or `aria-labelledby` on the chart container.
- For dense data views, pair the chart with an accessible data summary (table or list).

## Known tradeoffs

- Tooltips are visual-only; screen reader narration is not provided.
- Crosshair data values are not emitted to ARIA live regions by default.
- Complex multi-pane charts may require external descriptions for full accessibility.
