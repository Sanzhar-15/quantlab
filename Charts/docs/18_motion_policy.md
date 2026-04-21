# Motion Policy

Minimal, non-blocking motion rules used by Charts+.

## Allowed Motion

- Tooltip: opacity fade 140ms ease; inner content translateY 6px -> 0 over 140ms.
- Last-value text animation: existing 180ms value tween (unchanged).

## Reduced Motion

- If `prefers-reduced-motion: reduce`, tooltip transitions are disabled.
- Crosshair remains instant regardless of motion settings.

## Implementation Notes

- Tooltip motion lives in `apps/demo/index.html` (CSS only).
