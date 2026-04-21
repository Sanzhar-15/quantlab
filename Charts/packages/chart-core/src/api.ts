import type { LayoutResult, Rect } from './layout-engine';
import type { PriceScaleOptions } from './price-scale';
import type { DataProvider, DataProviderOptions } from './data-provider';

export type TimeMs = number; // ms since epoch

export type DataPoint = { t: TimeMs; v: number | null };

export type OhlcDataPoint = {
  t: TimeMs;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type HistogramDataPoint = { t: TimeMs; v: number; color?: string };

export type VisibleTimeRange = { from: TimeMs; to: TimeMs };

export type CrosshairMode = 'nearest' | 'interpolate' | 'magnet' | 'ohlc';

export type SeriesMarkerShape = 'circle' | 'square' | 'arrowUp' | 'arrowDown';

export type SeriesMarkerPosition = 'above' | 'below' | 'on';

export type SeriesMarker = {
  time: TimeMs;
  text?: string;
  color?: string;
  textColor?: string;
  size?: number;
  shape?: SeriesMarkerShape;
  position?: SeriesMarkerPosition;
};

export type WatermarkPosition =
  | 'center'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export type WatermarkOptions = {
  text?: string;
  color?: string;
  opacity?: number;
  fontSizePx?: number;
  fontFamily?: string;
  imageSrc?: string;
  imageWidth?: number;
  imageHeight?: number;
  position?: WatermarkPosition;
};

export type SeriesRendererMode = 'main' | 'worker' | 'auto';

export type AxisId = 'left' | 'right';

export type TimeZone = 'utc' | 'local';

export type PaneId = string;

export type LineRenderMode = 'linear' | 'step';

export type SeriesSampleMode = 'nearest' | 'linear' | 'hold';

export type PriceLineStyle = 'solid' | 'dashed' | 'dotted';

export type PriceLineSource = 'last' | 'close';

export type AxisOptions = PriceScaleOptions;

export type InertiaOptions = {
  enabled?: boolean;
  friction?: number;
  minVelocity?: number;
};

export type PanOptions = {
  overscanRatio?: number;
  freezeAxis?: boolean;
  freezeTicks?: boolean;
  freezeAxisThreshold?: number;
  axisSmoothing?: 'none' | 'inertia' | 'always';
};

export type HandleScrollOptions = {
  mouseWheel?: boolean;
  pressedMouseMove?: boolean;
  touchDrag?: boolean;
};

export type HandleScaleOptions = {
  mouseWheel?: boolean;
  pinch?: boolean;
  axisDrag?: boolean;
};

/**
 * Crosshair interaction options.
 * Allows fine-tuning crosshair behavior, including optional smoothing for magnet/ohlc modes.
 */
export type CrosshairOptions = {
  /**
   * Enable smoothing for crosshair movement in magnet/ohlc modes.
   * When enabled, the crosshair will smoothly interpolate between snap positions
   * instead of jumping instantly. This improves UX for magnet mode users while
   * maintaining direct manipulation (no smoothing) as the V5.2 default.
   * 
   * Default: false (V5.2 spec: direct, no smoothing)
   */
  smoothing?: boolean;
  /**
   * Smoothing factor (0-1) when smoothing is enabled.
   * Higher values = more responsive, lower values = smoother.
   * Default: 0.65 (matches previous behavior)
   */
  smoothingFactor?: number;
};

export type InteractionOptions = {
  inertia?: InertiaOptions;
  pan?: PanOptions;
  handleScroll?: HandleScrollOptions | boolean;
  handleScale?: HandleScaleOptions | boolean;
  crosshair?: CrosshairOptions;
};

export type PaneResizeOptions = {
  enabled?: boolean;
  handleHeightPx?: number;
  minHeightPx?: number;
};

export type PaneOptions = {
  resize?: PaneResizeOptions;
};

export type TimeScaleConfig = {
  minRangeMs?: number;
  minVisibleBars?: number;
  maxRangeMs?: number;
  clampToData?: boolean;
  paddingMs?: number;
  elasticClamp?: boolean;
  elasticMaxRatio?: number;
  timeVisible?: boolean;
  secondsVisible?: boolean;
  barSpacing?: number;
  rightOffset?: number;
  fitContent?: boolean;
  fixLeftEdge?: boolean;
  fixRightEdge?: boolean;
  lockVisibleTimeRangeOnResize?: boolean;
  tickMarkFormatter?: (time: TimeMs) => string;
};

export type MemoryBudgetOptions = {
  dataBytes?: number;
  lodBytes?: number;
  decimatorBytes?: number;
};

/**
 * Grid configuration options for the unified tick system.
 */
export type GridOptions = {
  // Visual
  majorColor?: string;
  majorOpacity?: number;
  minorColor?: string;
  minorOpacity?: number;
  lineWidth?: number;

  // Behavior
  targetMajorPx?: number;   // Ideal spacing between major ticks (default: 80)
  minMajorPx?: number;      // Minimum acceptable spacing (default: 50)
  maxMajorPx?: number;      // Maximum acceptable spacing (default: 120)
  showMinors?: boolean;     // Show minor grid lines (default: true)
  minMinorPx?: number;      // Minimum spacing to show minors (default: 12)

  // Transitions
  enableCrossFade?: boolean;     // Enable cross-fade transitions (default: true)
  crossFadeDuration?: number;    // Transition duration in ms (default: 120)

  // Nice Numbers
  useFinancialNice?: boolean;    // Use financial nice numbers (0.25, 2.5, 25, etc.) (default: true)

  // Edge ticks (TradingView feature)
  showEdgeTicks?: boolean;       // Show ticks at exact data min/max (default: false)
};

export type ThemeTokens = {
  background: string;
  gridMajor: string;
  gridMinor: string;
  axisText: string;
  crosshair: string;
  focusBand: string;
  tooltipBackground?: string;
  tooltipText?: string;
  tooltipBorder?: string;
  seriesPrimary: string;
  seriesSecondary: string;
  seriesTertiary: string;
  seriesQuaternary: string;
  seriesQuinary: string;
  fontFamily: string;
  fontSizePx: number;
};

export type ThemeTokensInput = Partial<ThemeTokens>;

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
  autoScroll?: boolean;
  crosshairMode?: CrosshairMode;
  watermark?: WatermarkOptions;
  gapThresholdMs?: number;
  rawRetentionMs?: number;
  timeScale?: TimeScaleConfig;
  timeZone?: TimeZone;
  timeFormatter?: (time: TimeMs) => string;
  axis?: {
    left?: AxisOptions;
    right?: AxisOptions;
  };
  grid?: GridOptions;
  memory?: MemoryBudgetOptions;
  seriesRenderer?: SeriesRendererMode;
  interaction?: InteractionOptions;
  panes?: PaneOptions;
};

export type LineSeriesOptions = {
  id?: string;
  paneId?: PaneId;
  axis?: AxisId;
  title?: string;
  color?: string;
  colorKey?: SeriesColorToken;
  width?: number;
  dash?: number[];
  opacity?: number;
  renderMode?: LineRenderMode;
  sampleMode?: SeriesSampleMode;
  visible?: boolean;
  lastValueVisible?: boolean;
  priceLineVisible?: boolean;
  priceLineStyle?: PriceLineStyle;
  priceLineColor?: string;
  priceLineSource?: PriceLineSource;
  lastValueAnimation?: boolean;
  isVolume?: boolean;
  valueFormatter?: (value: number) => string;
};

export type CandlestickSeriesOptions = LineSeriesOptions & {
  upColor?: string;
  downColor?: string;
  wickColor?: string;
  borderVisible?: boolean;
};

export type BarSeriesOptions = LineSeriesOptions & {
  upColor?: string;
  downColor?: string;
};

export type HistogramSeriesOptions = LineSeriesOptions & {
  baseValue?: number;
};

export type AreaSeriesOptions = LineSeriesOptions & {
  topColor?: string;
  bottomColor?: string;
};

export type BaselineSeriesOptions = LineSeriesOptions & {
  baseValue?: number;
  topColor?: string;
  bottomColor?: string;
};

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

export type CrosshairMoveEvent = {
  time: TimeMs;
  formattedTime: string;
  x: number;
  y: number;
  paneId?: PaneId;
  seriesValues: Map<string, { value: number | null; formatted: string }>;
};

export type CrosshairState = {
  time: TimeMs;
  paneId?: PaneId;
  yRatio?: number;
};

export type ExportPngOptions = {
  pixelRatio?: number;
  deterministic?: boolean;
  timeZone?: TimeZone;
  locale?: string;
  fontFamily?: string;
};

export type ImageBlob = typeof globalThis extends { Blob: infer T }
  ? T extends new (...args: any[]) => infer R
  ? R
  : unknown
  : unknown;

export type ExportPngResult = ImageBlob | string;

export type PluginPointerEvent = {
  type: 'down' | 'move' | 'up' | 'leave';
  x: number;
  y: number;
  time: TimeMs | null;
  inPlot: boolean;
};

export type PluginRenderState = {
  layout: LayoutResult;
  plotRect: Rect;
  visibleRange: VisibleTimeRange;
  /** Active pan overscroll offset in CSS pixels (positive = dragged right). */
  panOffset?: number;
  theme: ThemeTokens;
  timeToX: (time: TimeMs) => number;
  /** Inverse transform: convert X coordinate to time */
  xToTime: (x: number) => TimeMs;
  valueToY: (value: number) => number;
  valueToYLeft: (value: number) => number;
  valueToYRight: (value: number) => number;
  /** Inverse transform: convert Y coordinate to price value */
  yToValue: (y: number) => number;
  snapX: (x: number) => number;
  snapY: (y: number) => number;
};

export type ChartPlugin<Ctx = unknown> = {
  onInit?: (chart: Chart) => void;
  onRenderUnderlay?: (ctx: Ctx, state: PluginRenderState) => void;
  onRenderOverlay?: (ctx: Ctx, state: PluginRenderState) => void;
  /** Return true to indicate event was consumed and chart should not process it further */
  onPointer?: (event: PluginPointerEvent, state: PluginRenderState) => boolean | void;
};

export interface LineSeries {
  readonly id: string;
  setData(points: DataPoint[]): void;
  append(point: DataPoint): void;
  appendBatch(points: DataPoint[]): void;
  patchExisting(points: DataPoint[]): void;
  updateLast(point: DataPoint): void;
  setDataProvider(provider: DataProvider, options?: DataProviderOptions): void;
  setMarkers(markers: SeriesMarker[]): void;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
}

export interface CandlestickSeries {
  readonly id: string;
  setData(points: OhlcDataPoint[]): void;
  append(point: OhlcDataPoint): void;
  appendBatch(points: OhlcDataPoint[]): void;
  patchExisting(points: OhlcDataPoint[]): void;
  updateLast(point: OhlcDataPoint): void;
  setMarkers(markers: SeriesMarker[]): void;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
}

export interface BarSeries {
  readonly id: string;
  setData(points: OhlcDataPoint[]): void;
  append(point: OhlcDataPoint): void;
  appendBatch(points: OhlcDataPoint[]): void;
  patchExisting(points: OhlcDataPoint[]): void;
  updateLast(point: OhlcDataPoint): void;
  setMarkers(markers: SeriesMarker[]): void;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
}

export interface HistogramSeries {
  readonly id: string;
  setData(points: HistogramDataPoint[]): void;
  append(point: HistogramDataPoint): void;
  appendBatch(points: HistogramDataPoint[]): void;
  patchExisting(points: HistogramDataPoint[]): void;
  updateLast(point: HistogramDataPoint): void;
  setMarkers(markers: SeriesMarker[]): void;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
}

export interface AreaSeries {
  readonly id: string;
  setData(points: DataPoint[]): void;
  append(point: DataPoint): void;
  appendBatch(points: DataPoint[]): void;
  patchExisting(points: DataPoint[]): void;
  updateLast(point: DataPoint): void;
  setMarkers(markers: SeriesMarker[]): void;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
}

export interface BaselineSeries {
  readonly id: string;
  setData(points: DataPoint[]): void;
  append(point: DataPoint): void;
  appendBatch(points: DataPoint[]): void;
  patchExisting(points: DataPoint[]): void;
  updateLast(point: DataPoint): void;
  setMarkers(markers: SeriesMarker[]): void;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
}

export interface CustomSeries extends LineSeries { }

export interface PaneApi {
  readonly id: PaneId;
  setHeight(height: number): void;
  getHeight(): number | null;
  setStretchFactor(stretchFactor: number): void;
  getStretchFactor(): number;
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  moveTo(index: number): void;
  setPreserveEmptyPane(preserve: boolean): void;
  preserveEmptyPane(): boolean;
}

export interface Chart {
  addLineSeries(options?: LineSeriesOptions): LineSeries;
  addCustomSeries<Ctx = unknown>(options: CustomSeriesOptions<Ctx>): CustomSeries;
  addCandlestickSeries(options?: CandlestickSeriesOptions): CandlestickSeries;
  addBarSeries(options?: BarSeriesOptions): BarSeries;
  addHistogramSeries(options?: HistogramSeriesOptions): HistogramSeries;
  addAreaSeries(options?: AreaSeriesOptions): AreaSeries;
  addBaselineSeries(options?: BaselineSeriesOptions): BaselineSeries;
  getSeriesList(): LineSeries[];
  addPane(preserveEmptyPane?: boolean): PaneId;
  getPane(id: PaneId): PaneApi | null;
  getPanes(): PaneApi[];
  batch(fn: () => void): void;
  setAutoScroll(enabled: boolean): void;
  addPlugin<Ctx>(plugin: ChartPlugin<Ctx>): void;
  exportPng(options?: ExportPngOptions): Promise<ExportPngResult>;
  setAxisOptions(axis: AxisId, options: AxisOptions): void;
  setPaneAxisOptions(paneId: PaneId, axis: AxisId, options: AxisOptions): void;
  getAxisOptions(axis: AxisId): AxisOptions;
  setVisibleTimeRange(range: VisibleTimeRange): void;
  getVisibleTimeRange(): VisibleTimeRange;
  onVisibleTimeRangeChange(cb: (range: VisibleTimeRange) => void): () => void;
  setCrosshair(state: CrosshairState | null): void;
  onCrosshairMove(cb: (event: CrosshairMoveEvent) => void): () => void;
  setCrosshairMode(mode: CrosshairMode): void;
  setTheme(theme: ThemeTokensInput): void;
  setWatermark(options: WatermarkOptions | null): void;
  setGridOptions(options: Partial<GridOptions>): void;
  getGridOptions(): GridOptions;
  addIndicator(options: any): any; // V6: Indicator API
  removeIndicator(indicatorId: string): void; // V6: Indicator API
  destroy(): void;
}
