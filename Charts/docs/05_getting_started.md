# Getting Started

## Install

```bash
npm install @charts-plus/chart-render-canvas2d
```

## Basic example (copy-paste)

```html
<div id="chart" style="height: 360px;"></div>
```

```ts
import { createChart } from '@charts-plus/chart-render-canvas2d';

const chart = createChart('chart', { autoSize: true });
const series = chart.addLineSeries({ id: 'Macro', colorKey: 'seriesPrimary', width: 2 });

series.setData([
  { t: Date.UTC(2024, 0, 1, 9, 0, 0), v: 102.1 },
  { t: Date.UTC(2024, 0, 1, 10, 0, 0), v: 103.6 },
  { t: Date.UTC(2024, 0, 1, 11, 0, 0), v: null },
  { t: Date.UTC(2024, 0, 1, 12, 0, 0), v: 104.2 },
]);
```

## Example integrations

### Streaming (append + updateLast)

```ts
import { createChart } from '@charts-plus/chart-render-canvas2d';

const chart = createChart('chart', { autoSize: true, timeZone: 'local' });
const series = chart.addLineSeries({ id: 'Live', colorKey: 'seriesSecondary', width: 2 });

let t = Date.now();
let v = 100;
series.setData([{ t, v }]);

const windowMs = 30 * 60 * 1000;
setInterval(() => {
  const startNewBar = Math.random() < 0.2;
  if (startNewBar) {
    t += 1000;
    v += (Math.random() - 0.5) * 0.6;
    series.append({ t, v });
  } else {
    v += (Math.random() - 0.5) * 0.2;
    series.updateLast({ t, v });
  }
  chart.setVisibleTimeRange({ from: t - windowMs, to: t });
}, 250);
```

### Multi-axis (left + right)

```ts
import { createChart } from '@charts-plus/chart-render-canvas2d';

const chart = createChart('chart', {
  autoSize: true,
  axis: {
    right: { format: 'percent', decimals: 2 },
  },
});

const price = chart.addLineSeries({ id: 'Price', colorKey: 'seriesPrimary' });
const rate = chart.addLineSeries({ id: 'Rate', axis: 'right', colorKey: 'seriesSecondary' });

price.setData([
  { t: 0, v: 102 },
  { t: 1, v: 104 },
]);
rate.setData([
  { t: 0, v: 0.012 },
  { t: 1, v: 0.018 },
]);

chart.setAxisOptions('left', { format: 'decimal', decimals: 2 });
```

### Axis scale options

```ts
chart.setAxisOptions('left', {
  scaleMargins: { top: 0.15, bottom: 0.1 },
  invertScale: false,
  ticksVisible: true,
  borderVisible: true,
  minWidth: 56,
  priceFormat: { precision: 2, minMove: 0.01 },
});
```

Percent/indexed modes use the first visible value on that axis as the baseline:

```ts
chart.setAxisOptions('left', { mode: 'percentage' }); // percent change from baseline
chart.setAxisOptions('left', { mode: 'indexedTo100' }); // rebase to 100
```

### Series price line + last value

```ts
const series = chart.addLineSeries({
  id: 'Price',
  title: 'Price',
  colorKey: 'seriesPrimary',
  lastValueVisible: true,
  priceLineVisible: true,
  priceLineStyle: 'dotted',
  priceLineColor: '#5ad3f5',
  priceLineSource: 'last',
  lastValueAnimation: true,
});
```

### Additional series APIs

```ts
const candle = chart.addCandlestickSeries({ id: 'OHLC' });
const bars = chart.addBarSeries({ id: 'Bars' });
const hist = chart.addHistogramSeries({ id: 'Volume' });
const area = chart.addAreaSeries({ id: 'Area' });
const baseline = chart.addBaselineSeries({ id: 'Baseline' });

// Candlestick/bar/histogram/area/baseline renderers are available in the Canvas2D backend.
```

### Panes (height, stretch, preserve, resize)

```ts
const paneId = chart.addPane(false);
const pane = chart.getPane(paneId);

pane?.setHeight(140);
pane?.setStretchFactor(1.5);
pane?.setPreserveEmptyPane(true);

const chartWithResize = createChart('chart', {
  autoSize: true,
  panes: {
    resize: { enabled: true, minHeightPx: 80, handleHeightPx: 8 },
  },
});
```

### Interaction options (scroll/scale)

```ts
const chart = createChart('chart', {
  interaction: {
    handleScroll: { mouseWheel: true, pressedMouseMove: true, touchDrag: true },
    handleScale: { mouseWheel: true, pinch: true, axisDrag: true },
  },
});
```

### Optional Worker rendering

```ts
import '@charts-plus/chart-render-canvas2d/worker';
import { createChart } from '@charts-plus/chart-render-canvas2d';

const chart = createChart('chart', { autoSize: true, seriesRenderer: 'auto' });
```

### Deterministic PNG export

```ts
const result = await chart.exportPng({
  deterministic: true,
  pixelRatio: 1,
  timeZone: 'utc',
  locale: 'en-US',
});
```

### Time scale options

```ts
import { createChart } from '@charts-plus/chart-render-canvas2d';

const chart = createChart('chart', {
  autoSize: true,
  timeScale: {
    barSpacing: 12,
    rightOffset: 2,
    timeVisible: true,
    secondsVisible: false,
    fitContent: true,
    fixLeftEdge: true,
    fixRightEdge: true,
    lockVisibleTimeRangeOnResize: false,
    tickMarkFormatter: (time) => new Date(time).toISOString().slice(11, 19),
  },
});
```

### Yield curve (numeric month axis)

```ts
import { createYieldCurveChart } from '@charts-plus/chart-render-canvas2d';

const chart = createYieldCurveChart('chart', { autoSize: true });
const curve = chart.addLineSeries({ id: 'Curve', colorKey: 'seriesPrimary' });

curve.setData([
  { t: 1, v: 4.2 }, // 1M
  { t: 3, v: 4.3 },
  { t: 6, v: 4.4 },
  { t: 12, v: 4.6 }, // 1Y
  { t: 60, v: 4.9 }, // 5Y
  { t: 120, v: 5.1 }, // 10Y
]);

chart.setVisibleTimeRange({ from: 1, to: 120 });
```

### Options chart (numeric X axis)

```ts
import { createOptionsChart } from '@charts-plus/chart-render-canvas2d';

const chart = createOptionsChart('chart', { autoSize: true });
const smile = chart.addLineSeries({ id: 'Smile', colorKey: 'seriesSecondary', width: 2 });

smile.setData([
  { t: 80, v: 0.34 },
  { t: 90, v: 0.3 },
  { t: 100, v: 0.27 },
  { t: 110, v: 0.29 },
  { t: 120, v: 0.33 },
]);

chart.setVisibleTimeRange({ from: 80, to: 120 });
```
