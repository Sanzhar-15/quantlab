# Migration: V1 to V2

V2 is additive at the API surface. Most V1 code runs unchanged, but there are new
options and a few default behaviors worth updating.

## Notable changes

- **Time formatting is explicit.** Use `timeZone: 'local'` or `timeFormatter` when you
  want local or custom time labels. Default formatting is UTC for determinism.
- **Multi-axis support.** Assign a series to the right axis with `axis: 'right'` and
  configure axis formatting via `axis` in `createChart` or `chart.setAxisOptions`.
- **Crosshair events include `formattedTime`.** Prefer `event.formattedTime` over
  manual `Date` formatting for consistency.
- **Worker rendering is opt-in.** Import the worker entrypoint and set
  `seriesRenderer: 'auto'` to enable it.

## Quick upgrade examples

### Time formatting

```ts
const chart = createChart('chart', {
  autoSize: true,
  timeZone: 'local',
  timeFormatter: (time) => new Date(time).toLocaleTimeString(),
});

chart.onCrosshairMove((event) => {
  console.log(event.formattedTime);
});
```

### Multi-axis

```ts
const chart = createChart('chart', {
  autoSize: true,
  axis: { right: { format: 'percent', decimals: 2 } },
});

chart.addLineSeries({ id: 'Left', colorKey: 'seriesPrimary' });
chart.addLineSeries({ id: 'Right', axis: 'right', colorKey: 'seriesSecondary' });
```

### Worker rendering

```ts
import '@charts-plus/chart-render-canvas2d/worker';
import { createChart } from '@charts-plus/chart-render-canvas2d';

createChart('chart', { autoSize: true, seriesRenderer: 'auto' });
```

## No removals from V1

- `createChart`, `addLineSeries`, `setData`, `append`, `updateLast`, and plugins
  are unchanged.
- If you relied on V1 defaults for time formatting, make the new defaults explicit
  (`timeZone` or `timeFormatter`) to avoid ambiguity.
