# v1 API Spec (frozen)

This document defines the v1 public API surface (TypeScript-first). Behavior notes are brief and normative.

## Types

```ts
export type TimeMs = number; // ms since epoch

export type DataPoint = { t: TimeMs; v: number | null };

export type VisibleTimeRange = { from: TimeMs; to: TimeMs };

export type CrosshairMode = 'nearest' | 'interpolate';

export type TimeScaleConfig = {
  minRangeMs?: number;
  maxRangeMs?: number;
  clampToData?: boolean;
  paddingMs?: number;
  elasticClamp?: boolean;
  elasticMaxRatio?: number;
};

export type ThemeTokens = {
  background: string;
  gridMajor: string;
  gridMinor: string;
  axisText: string;
  crosshair: string;
  focusBand: string;
  seriesPrimary: string;
  seriesSecondary: string;
  seriesTertiary: string;
  seriesQuaternary: string;
  seriesQuinary: string;
  fontFamily: string;
  fontSizePx: number;
};

export type SeriesColorToken =
  | 'seriesPrimary'
  | 'seriesSecondary'
  | 'seriesTertiary'
  | 'seriesQuaternary'
  | 'seriesQuinary';

export type CreateChartOptions = {
  autoSize?: boolean;
  width?: number;
  height?: number;
  crosshairMode?: CrosshairMode;
  timeScale?: TimeScaleConfig;
};

export type LineSeriesOptions = {
  id?: string;
  color?: string; // explicit color; if omitted, renderer may pick from theme/palette
  colorKey?: SeriesColorToken; // optional theme token key for palette-based color
  width?: number;
  dash?: number[];
  opacity?: number;
  visible?: boolean; // default true
  valueFormatter?: (value: number) => string;
};

export type ExportPngOptions = {
  pixelRatio?: number;
};

export type ExportPngResult = Blob | string;

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LayoutResult = {
  chartRect: Rect;
  plotRect: Rect;
  leftAxisRect: Rect | null;
  rightAxisRect: Rect | null;
};

export type PluginPointerEvent = {
  type: 'down' | 'move' | 'up' | 'leave';
  x: number; // canvas-local x
  y: number; // canvas-local y
  time: TimeMs | null; // null if pointer is outside the plot
  inPlot: boolean;
};

export type PluginRenderState = {
  layout: LayoutResult;
  plotRect: Rect;
  visibleRange: VisibleTimeRange;
  theme: ThemeTokens;
  timeToX: (time: TimeMs) => number; // returns canvas-local x
  valueToY: (value: number) => number; // returns canvas-local y
  snapX: (x: number) => number;
  snapY: (y: number) => number;
};

export type ChartPlugin<Ctx = unknown> = {
  onInit?: (chart: Chart) => void;
  onRenderUnderlay?: (ctx: Ctx, state: PluginRenderState) => void;
  onRenderOverlay?: (ctx: Ctx, state: PluginRenderState) => void;
  onPointer?: (event: PluginPointerEvent, state: PluginRenderState) => void;
};
```

## Entry point

```ts
export function createChart(container: HTMLElement | string, options?: CreateChartOptions): Chart;
```

Behavior:

- `container` may be an element or an element id.
- Must be SSR-safe at import time (no top-level `window` access).

## Chart

```ts
export interface Chart {
  addLineSeries(options?: LineSeriesOptions): LineSeries;
  getSeriesList(): LineSeries[];
  addPlugin<Ctx>(plugin: ChartPlugin<Ctx>): void;
  exportPng(options?: ExportPngOptions): Promise<ExportPngResult>;

  setVisibleTimeRange(range: VisibleTimeRange): void;
  getVisibleTimeRange(): VisibleTimeRange;

  onCrosshairMove(cb: (event: CrosshairMoveEvent) => void): () => void; // returns unsubscribe

  setTheme(theme: ThemeTokens): void;

  destroy(): void;
}
```

## Plugins

Behavior:

- `onRenderUnderlay` runs after background fill and before grid + series; `onRenderOverlay` runs after series.
- Renderer clips plugin drawing to `plotRect`.
- `onPointer` runs for pointer down/move/up/leave events; `time` is null when outside the plot.
- `exportPng` returns a `Blob` when available, otherwise a data URL string.

## LineSeries

```ts
export interface LineSeries {
  readonly id: string;

  setData(points: DataPoint[]): void;
  append(point: DataPoint): void;
  updateLast(point: DataPoint): void;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
}
```

Behavior:

- `setData` replaces all points.
- `null` values break the line (gaps).
- Series data must be monotonic in `t` (documented behavior for out-of-order updates).
- Autoscale uses all visible series combined (single shared price scale).

## Crosshair events

```ts
export type CrosshairMoveEvent = {
  time: TimeMs;
  x: number; // canvas-local x
  y: number; // canvas-local y
  seriesValues: Map<string, { value: number | null; formatted: string }>;
};
```

Behavior:

- `time` is derived from `x` via `xToTime`.
- Per-series value selection uses `crosshairMode`:
  - `'nearest'`: choose nearest sample (default for discrete macro points).
  - `'interpolate'`: linear interpolation between surrounding samples (optional).

## Additive APIs (post‑V1)

V1 remains frozen. Newer additive APIs are documented in `docs/04_v2_api_contract.md`
and include:

- Additional series types: area, baseline, histogram, candlestick, bar.
- Series markers (`setMarkers`) and chart watermark (`setWatermark`).
- Custom series renderer (`addCustomSeries`).
