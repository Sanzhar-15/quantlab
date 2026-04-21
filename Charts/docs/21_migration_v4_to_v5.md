# Migration: V4 to V5 (Additive)

V5 is additive-only. Existing V4 integrations continue to work without changes.
This doc highlights new options and safe upgrade paths; no adapter is required.

## Compatibility mapping

| V4 usage | V5 usage | Notes |
| --- | --- | --- |
| Multiple charts to simulate panes | `chart.addPane()` + `paneId` on series | Shared time scale, fewer canvases |
| Manual chart sync | `createSyncGroup()` | Add charts to group for shared pan/crosshair |
| Custom OHLC rendering | `addCandlestickSeries()` / `addBarSeries()` | Built-in rendering + LOD |
| Custom histogram rendering | `addHistogramSeries()` | Supports per-point colors |
| Manual area/baseline | `addAreaSeries()` / `addBaselineSeries()` | Built-in fills + baseValue |
| Manual export pipeline | `chart.exportPng({ deterministic: true })` | Deterministic export options |
| Manual streaming batching | `chart.batch()` + `series.appendBatch()` | Coalesced invalidations |
| Manual revisions | `series.patchExisting()` | Dirty-range updates |
| Custom auto-scroll | `chart.setAutoScroll(true)` | Uses pan cache for live mode |
| Custom clamp behavior | `timeScale.clampToData` + `elasticClamp` | Smooth “elastic” bounds |
| Manual memory trimming | `rawRetentionMs` + `memory` budgets | Keeps LOD outside window |

## New options (safe to ignore)

- `timeScale.elasticClamp` + `timeScale.elasticMaxRatio` for bounded zoom.
- `rawRetentionMs` + `memory` for long-history compaction.
- `crosshairMode: 'magnet' | 'ohlc'` and per-series `sampleMode`.
- `pan` and `inertia` options under `interaction` for smoother drag/zoom.
- Theme tokens: tooltip colors, contrast-safe presets.

## Deprecation policy

- No removals in V5. Any deprecation is documented and remains supported for
  at least one major version.
- Debug APIs are non-public; names may grow but are additive only.

## Examples

### Multi-pane conversion

```ts
const chart = createChart('chart', { autoSize: true });
const ratesPane = chart.addPane();
chart.addLineSeries({ id: 'Core', colorKey: 'seriesPrimary' });
chart.addLineSeries({ id: 'Rates', paneId: ratesPane, axis: 'right' });
```

### Sync group

```ts
import { createChart, createSyncGroup } from '@charts-plus/chart-render-canvas2d';

const group = createSyncGroup();
const a = createChart('a', { autoSize: true });
const b = createChart('b', { autoSize: true });
group.add(a);
group.add(b);
```

### Candlestick series

```ts
const chart = createChart('chart', { autoSize: true });
const candles = chart.addCandlestickSeries({ id: 'OHLC' });
candles.setData([{ t: 0, o: 10, h: 12, l: 9, c: 11 }]);
```
