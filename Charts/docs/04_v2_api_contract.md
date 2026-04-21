# V2 API Contract (locked before heavy implementation)

This document records V2 behavior decisions that must remain stable while we implement the data
pipeline, LOD, and worker rendering. It intentionally does not replace the V1 spec.

## Time + time formatting

- All times are epoch milliseconds (UTC) in data and API.
- Time zone affects formatting only; it never changes spacing or layout.
- Default time zone is `utc` for determinism; `local` is opt-in.

```ts
export type TimeZone = 'utc' | 'local';

export type CreateChartOptions = {
  timeZone?: TimeZone; // default 'utc'
  timeFormatter?: (time: TimeMs) => string;
  axis?: {
    left?: AxisOptions;
    right?: AxisOptions;
  };
};

export type CrosshairMoveEvent = {
  time: TimeMs;
  formattedTime: string;
  x: number;
  y: number;
  seriesValues: Map<string, { value: number | null; formatted: string }>;
};
```

## Formatting hooks

- Axis labels and crosshair values share the same formatting path.
- Series `valueFormatter` takes precedence over axis formatting.

```ts
export type AxisId = 'left' | 'right';
export type PriceScaleFormat = 'decimal' | 'percent' | 'bps';

export type AxisOptions = {
  type?: 'linear' | 'log';
  format?: PriceScaleFormat;
  formatter?: (value: number) => string;
  tickCount?: number;
  decimals?: number;
};

export type LineSeriesOptions = {
  id?: string;
  axis?: AxisId; // default 'left'
  valueFormatter?: (value: number) => string; // per-series override
};
```

## Memory budgets (cache control)

```ts
export type MemoryBudgetOptions = {
  dataBytes?: number; // chunked store budget (approx bytes)
  lodBytes?: number; // per-series LOD budget
  decimatorBytes?: number; // shared decimator cache budget
};

export type CreateChartOptions = {
  memory?: MemoryBudgetOptions;
};
```

Behavior:

- Budgets are best-effort and approximate; caches trim to stay within limits.
- Under pressure, LOD drops higher-resolution levels first.
- Visible window should always be retained with a small padding margin.

## Streaming and ordering semantics

- `setData` requires strictly increasing time values.
- `append` requires `t > lastTime`.
- `updateLast` requires `t >= lastTime`:
  - If `t === lastTime`, it replaces the last value.
  - If `t > lastTime`, it behaves like `append`.
- Out-of-order inputs are rejected (throw) for `LineSeries`.

## Gaps and crosshair behavior

- `null` values create gaps; gaps are represented as NaN internally.
- Rendering and crosshair logic respect gaps:
  - Interpolation only occurs when both adjacent samples are finite.
  - If either neighbor is a gap, interpolation falls back to nearest.
  - If the nearest neighbors are both gaps, the value is `null`.

## Multi-axis mapping

- V2 supports two axes: `left` and `right`.
- A series binds to an axis via `axis` (default `left`).
- Axis configuration is explicit and stable:

```ts
export interface Chart {
  setAxisOptions(axis: AxisId, options: AxisOptions): void;
  getAxisOptions(axis: AxisId): AxisOptions;
}
```

## Optional DataProvider (virtualized data)

- DataProvider is optional; if provided it powers chunked loading and streaming updates.
- Large range loads use typed arrays to avoid object-per-point costs.

```ts
export type OutOfOrderPolicy = 'reject' | 'drop';
export type DuplicatePolicy = 'reject' | 'replace' | 'ignore';
export type NonFinitePolicy = 'allow' | 'gap';

export type DataChunk = {
  time: Float64Array;
  value: Float64Array; // NaN for gaps
  length: number;
};

export type DataProviderUpdate =
  | { type: 'append'; point: DataPoint }
  | { type: 'updateLast'; point: DataPoint }
  | { type: 'reset'; chunk: DataChunk; range: VisibleTimeRange };

export type DataProvider = {
  getRange: (range: VisibleTimeRange, options?: { paddingMs?: number }) => Promise<DataChunk>;
  subscribe?: (cb: (update: DataProviderUpdate) => void) => () => void;
  getExtents?: () => Promise<VisibleTimeRange | null>;
};

export type DataProviderOptions = {
  prefetchMs?: number;
  maxPendingUpdates?: number;
  backpressure?: 'drop' | 'coalesce';
  outOfOrder?: OutOfOrderPolicy;
  duplicates?: DuplicatePolicy;
  nonFinite?: NonFinitePolicy;
  chunkSize?: number;
  maxChunks?: number; // ring-buffer cap (oldest evicted first)
  maxBytes?: number; // ring-buffer cap in bytes (approx)
};

export interface LineSeries {
  setDataProvider(provider: DataProvider, options?: DataProviderOptions): void;
}
```

Notes:

- DataProvider updates respect `outOfOrder` semantics.
- `duplicates: 'replace'` updates the last sample when a duplicate timestamp arrives; `ignore` drops it.
- If `duplicates` is not set, it follows `outOfOrder` (`drop` -> ignore duplicates, `reject` -> reject).
- `nonFinite: 'gap'` converts NaN/Infinity inputs to gaps (NaN) during ingest.
- Prefetch is advisory; it must not grow the working set beyond cache budgets.
- `maxChunks`/`maxBytes` apply per-series and evict oldest chunks when exceeded.

## Prefetch + backpressure rules

- `prefetchMs` expands requested ranges on both sides of the visible window.
- `maxPendingUpdates` caps the streaming queue size.
- `backpressure: 'drop'` drops newest updates when the queue is full.
- `backpressure: 'coalesce'` keeps only the latest update per type (append/updateLast/reset).

## Export options

```ts
export type ExportPngOptions = {
  pixelRatio?: number;
  deterministic?: boolean;
  timeZone?: TimeZone; // export-only override
  locale?: string; // export-only override
  fontFamily?: string; // export-only override
};
```

## V3+ additive API surface (kept additive vs V1/V2)

### Series type additions

```ts
export interface Chart {
  addAreaSeries(options?: AreaSeriesOptions): AreaSeries;
  addBaselineSeries(options?: BaselineSeriesOptions): BaselineSeries;
  addHistogramSeries(options?: HistogramSeriesOptions): HistogramSeries;
  addCandlestickSeries(options?: CandlestickSeriesOptions): CandlestickSeries;
  addBarSeries(options?: BarSeriesOptions): BarSeries;
}
```

### Markers + watermark

```ts
export type SeriesMarker = {
  time: TimeMs;
  text?: string;
  color?: string;
  textColor?: string;
  size?: number;
  shape?: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
  position?: 'above' | 'below' | 'on';
};

export type WatermarkOptions = {
  text?: string;
  color?: string;
  opacity?: number;
  fontSizePx?: number;
  fontFamily?: string;
  imageSrc?: string;
  imageWidth?: number;
  imageHeight?: number;
  position?: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
};

export interface Chart {
  setWatermark(options: WatermarkOptions | null): void;
}

export interface LineSeries {
  setMarkers(markers: SeriesMarker[]): void;
}
```

Behavior:

- Markers are additive and independent of the line path; they do not mutate data.
- Watermark renders behind grid + series and respects `plotRect` bounds.

### Custom series renderer

```ts
export type CustomSeriesRenderData = {
  time: Float64Array;
  value: Float64Array;
  length: number;
};

export type CustomSeriesRenderState = {
  id: string;
  paneId: PaneId;
  axis: AxisId;
  plotRect: Rect;
  visibleRange: VisibleTimeRange;
  data: CustomSeriesRenderData;
  timeToX: (time: TimeMs) => number;
  valueToY: (value: number) => number;
  valueToYLeft: (value: number) => number;
  valueToYRight: (value: number) => number;
  snapX: (x: number, lineWidth?: number) => number;
  snapY: (y: number, lineWidth?: number) => number;
  alignLineWidth: (width: number) => number;
  theme: ThemeTokens;
  options: LineSeriesOptions;
  renderMode: LineRenderMode;
  gapThresholdMs: number | null;
  pixelRatio: number;
};

export type CustomSeriesRenderer<Ctx = unknown> = {
  draw: (ctx: Ctx, state: CustomSeriesRenderState) => void;
};

export type CustomSeriesOptions<Ctx = unknown> = LineSeriesOptions & {
  renderer: CustomSeriesRenderer<Ctx>;
};

export interface CustomSeries extends LineSeries {}

export interface Chart {
  addCustomSeries<Ctx = unknown>(options: CustomSeriesOptions<Ctx>): CustomSeries;
}
```

Behavior:

- Custom series render on the main thread; worker mode is skipped for charts containing custom series.
- Custom series follow line-series data semantics (monotonic time, gaps via `null`).
