import type {
  Chart,
  ChartPlugin,
  CreateChartOptions,
  CrosshairMode,
  CrosshairMoveEvent,
  CrosshairState,
  CustomSeries,
  CustomSeriesOptions,
  CustomSeriesRenderer,
  DataProvider,
  DataProviderOptions,
  DataProviderUpdate,
  AxisId,
  BarSeries,
  BarSeriesOptions,
  BaselineSeries,
  BaselineSeriesOptions,
  CandlestickSeries,
  CandlestickSeriesOptions,
  DataPoint,
  ExportPngOptions,
  ExportPngResult,
  HistogramDataPoint,
  HistogramSeries,
  HistogramSeriesOptions,
  LineSeries,
  LineSeriesOptions,
  OhlcDataPoint,
  AreaSeries,
  AreaSeriesOptions,
  ChunkStats,
  HandleScaleOptions,
  HandleScrollOptions,
  PaneApi,
  PaneId,
  PluginPointerEvent,
  PluginRenderState,
  PriceLineStyle,
  PriceScaleMode,
  Rect,
  SeriesRendererMode,
  SeriesMarker,
  ThemeTokens,
  ThemeTokensInput,
  TimeMs,
  TimeZone,
  VisibleTimeRange,
  WatermarkOptions,
  Tick,
  GridOptions,
} from '@charts-plus/chart-core';
import {
  installDebugAPI,
  adjustFrictionForAccessibility,
} from '@charts-plus/chart-core';
import {
  ChunkedDataStore,
  ChunkedLineDecimator,
  clamp,
  DataStore,
  normalizeThemeTokens,
  OhlcDataStore,
  FrameScheduler,
  type HorizontalScale,
  InvalidationFlag,
  LayoutEngine,
  LineDecimator,
  OhlcDecimator,
  LodPyramid,
  OhlcLodPyramid,
  NumericScale,
  PriceScale,
  TimeScale,
  lowerBound,
  upperBound,
  type ChunkedDataStoreOptions,
  type InputIntent,
  type LayoutResult,
  type NumericScaleOptions,
} from '@charts-plus/chart-core';

import { CanvasSurface } from './canvas-surface';
import {
  applyAxisMargins,
  applyAxisPadding,
  computeAxisRange,
  type AxisScaleChunk,
  type AxisScaleSource,
  type AxisScaleRange,
  type AxisBucketStats,
} from './axis-utils';
import { renderYAxis, renderXAxis, type AxisLabel, type TimeLabel } from './axis-renderer';
import { renderGrid, clearGridCache, renderGridFromTicks } from './grid-renderer';
import { GridTransitionManager } from './grid-transition';
import { LabelMeasureCache } from './label-cache';
import { TickCoordinator } from './tick-coordinator';
import { FrameBudget } from './frame-budget';
import { InputCoalescer } from './input-coalescer';
import { CoordinateStabilizer } from './coordinate-stabilizer';
import { RenderStateSnapshot } from './render-state-snapshot';
import { QualityTransitionManager } from './quality-transition';
import { FrameTimingMonitor } from './frame-timing-monitor';
import {
  renderLineSeries,
  type LinePathCache,
  type LinePathCacheEntry,
  type SnapSurface,
} from './line-series-renderer';
import { renderAreaFill, renderBaselineFill } from './area-series-renderer';
import { renderCandlestickSeries } from './candlestick-series-renderer';
import {
  renderHistogramSeries,
  type HistogramSeriesRenderInput,
} from './histogram-series-renderer';
import { getChartRuntime, type RuntimePriority } from './chart-runtime';
import { renderOhlcBarSeries } from './ohlc-bar-series-renderer';
import { getLodWorkerFactory, getSeriesWorkerFactory } from './worker-registry';

// Export the renderer class for the renderer factory
export { Canvas2DRenderer } from './renderer';

type InternalSeries = {
  id: string;
  order: number;
  seriesType: 'line' | 'area' | 'baseline' | 'histogram' | 'candlestick' | 'bar' | 'custom';
  options: LineSeriesOptions;
  axis: AxisId;
  paneId: PaneId;
  data: DataStore | ChunkedDataStore;
  dataMode: 'static' | 'provider';
  provider: SeriesProviderState | undefined;
  chunkLods: Map<number, ChunkLodEntry>;
  ohlcData: OhlcDataStore | null;
  ohlcLod: OhlcLodPyramid | null;
  ohlcAxisBuckets: AxisBucketStats[] | null;
  ohlcAxisBucketSize: number;
  visible: boolean;
  handle: LineSeries;
  lod: LodPyramid;
  lodVersion: number;
  lodBuildToken: LodBuildToken | null;
  dirtyRange: VisibleTimeRange | null;
  axisBuckets: AxisBucketStats[] | null;
  axisBucketSize: number;
  renderRevision: number;
  crosshairCache: SeriesCrosshairCache | null;
  lastValue: number | null;
  lastValueText: string;
  lastValueColor: string;
  lastValueDisplay: number | null;
  lastValueAnimation: LastValueAnimationState | null;
  timeStepMs: number | null;
  timeStepSamples: number[];
  lastTimeMs: number | null;
  scaleBase: number | null;
  markers: SeriesMarker[];
  markerTimes: Float64Array | null;
  customRenderer: CustomSeriesRenderer<CanvasRenderingContext2D> | null;
};

type SeriesCrosshairCache = {
  time: number;
  leftIndex: number;
  rightIndex: number;
  value: number | null;
  mode: 'nearest' | 'linear' | 'hold';
  gapThreshold: number | null;
  renderRevision: number;
};

type LastValueAnimationState = {
  from: number;
  startedAt: number;
};

type InternalPane = {
  id: PaneId;
  leftScale: PriceScale;
  rightScale: PriceScale;
  stretchFactor: number;
  fixedHeight: number | null;
  preserveEmpty: boolean;
  visible: boolean;
  maxVolume?: number;
  handle: PaneApi;
};

type PaneState = {
  id: PaneId;
  plotRect: Rect;
  leftAxisRect: Rect | null;
  rightAxisRect: Rect | null;
  axisUsage: Record<AxisId, boolean>;
  primaryAxis: AxisId;
  axisLabelsLeft: AxisLabel[];
  axisLabelsRight: AxisLabel[];
  // gridY removed - will be reimplemented with new grid system
  leftBorderVisible: boolean;
  rightBorderVisible: boolean;
};

type SeriesProviderState = {
  provider: DataProvider;
  options: DataProviderOptions;
  unsubscribe?: () => void;
  loadedRange: VisibleTimeRange | null;
  pendingRange: VisibleTimeRange | null;
  requestId: number;
  queue: DataProviderUpdate[];
  scheduled: boolean;
  extents: VisibleTimeRange | null;
};

type CancellableToken = {
  canceled: boolean;
};

type ChunkLodEntry = {
  lod: LodPyramid;
  startTime: number;
  length: number;
  endTime: number;
  lastValue: number;
  bytes: number;
  lastTouched: number;
  pendingRequestId: number | null;
  pendingBuildToken: CancellableToken | null;
  lodOnly: boolean;
  lodOnlyBase?: {
    time: Float64Array;
    value: Float64Array;
    length: number;
  } | null;
  lodStats?: ChunkStats;
};

type PaintStyles = {
  background: string;
  gridMajor: string;
  gridMinor: string;
  axisText: string;
  crosshair: string;
  focusBand: string;
  fontFamily: string;
  fontSizePx: number;
  font: string;
  axisPadding: number;
  seriesPalette: string[];
};

type LodWorkerLevel = {
  bucketSize: number;
  time: Float64Array;
  value: Float64Array;
  length: number;
  offsets?: Int32Array;
};

type LodWorkerResponse = {
  requestId: number;
  length: number;
  levels?: LodWorkerLevel[];
  done?: boolean;
};

type LodBuildToken = CancellableToken & {
  version: number;
  length: number;
};

type ChunkLodRequest = {
  series: InternalSeries;
  chunkStart: number;
  length: number;
  endTime: number;
  levels: LodWorkerLevel[];
};

type SeriesWorkerSeries = {
  id: string;
  seriesType: 'line' | 'bar' | 'candlestick';
  time: Float64Array;
  value?: Float64Array;
  open?: Float64Array;
  high?: Float64Array;
  low?: Float64Array;
  close?: Float64Array;
  barWidth?: number;
  upColor?: string;
  downColor?: string;
  wickColor?: string | null;
  borderVisible?: boolean;
  color: string;
  width: number;
  dash: number[];
  opacity: number;
  renderMode?: 'linear' | 'step';
  plotRect?: { x: number; y: number; width: number; height: number };
  scale: SeriesWorkerScale;
  scaleMode?: PriceScaleMode;
  scaleBase?: number | null;
};

type SeriesWorkerScale = {
  min: number;
  max: number;
  type: 'linear' | 'log';
  minPositive: number;
  height: number;
};

type SeriesWorkerRenderMessage = {
  type: 'render';
  plotRect: { x: number; y: number; width: number; height: number };
  visibleRange: VisibleTimeRange;
  scale: SeriesWorkerScale;
  themeVersion: number;
  gapThresholdMs?: number | null;
  series: SeriesWorkerSeries[];
};

type SeriesWorkerMessage =
  | {
    type: 'init';
    canvas: OffscreenCanvas;
    pixelWidth: number;
    pixelHeight: number;
    dpr: number;
  }
  | {
    type: 'resize';
    pixelWidth: number;
    pixelHeight: number;
    dpr: number;
  }
  | SeriesWorkerRenderMessage;

type AxisRangeSnapshot = {
  left: Pick<AxisScaleRange, 'min' | 'max' | 'minPositive'>;
  right: Pick<AxisScaleRange, 'min' | 'max' | 'minPositive'>;
};

type AxisManualRange = Pick<AxisScaleRange, 'min' | 'max' | 'minPositive'>;

type AxisDragState = {
  pointerId: number;
  paneId: PaneId;
  axis: AxisId | 'time';
  startY: number;
  startX: number;
  anchorRatio: number;
  anchorValue: number;
  span: number;
  scaleType: 'linear' | 'log';
  startRange: AxisManualRange;
  logMin?: number;
  logSpan?: number;
  anchorLog?: number;
  sensitivityMultiplier?: number;
};

type PanCacheState = {
  axis: AxisId;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dpr: number;
  width: number;
  height: number;
  plotRect: Rect;
  range: VisibleTimeRange;
  overscanRatio: number;
  overscanPx: number;
  seriesRevision: number;
  themeVersion: number;
  scale: SeriesWorkerScale;
  firstSeriesOrder: number;
};

const LOD_MAX_LEVELS = 8;
const LOD_MIN_POINTS = 2048;
const LOD_RETENTION_MIN_POINTS = 2;
const LOD_ASYNC_THRESHOLD = 100_000;
const LOD_CHUNK_POINTS = 50_000;
const LOD_PREVIEW_LEVELS = 1;
const DEFAULT_DECIMATOR_BYTES = 8 * 1024 * 1024;
const DEFAULT_LOD_BYTES = 48 * 1024 * 1024;
const AXIS_BUCKET_SIZE = 512;
const AXIS_BUCKET_MIN_COUNT = 4;
const AXIS_BUCKET_TARGET_COUNT = 1024;
const PAN_OVERSCAN_RATIO = 0.25;
const PAN_OVERSCROLL_LIMIT_RATIO = 0.03;
const PAN_OVERSCROLL_MIN_PX = 6;
const PAN_OVERSCROLL_MAX_PX = 20;
const PAN_OVERSCROLL_RETURN_MS = 60;
const PATH_CACHE_MAX_ENTRIES = 64;
const PATH_CACHE_MAX_POINTS = 20_000;
const MIN_TIME_TICK_SPACING = 96;
const MAX_TIME_TICKS = 10;
const TIME_LABEL_HYSTERESIS_RATIO = 0.15;
const AXIS_LABEL_SPACING_RATIO = 1.6;
const MIN_AXIS_LABEL_SPACING = 18;
const SMALL_PANE_HEIGHT_THRESHOLD = 150;  // Panes below this height get increased spacing
const SMALL_PANE_SPACING_MULTIPLIER = 1.8;  // Multiplier for spacing in small panes
const AXIS_WIDTH_HYSTERESIS_RATIO = 0.1;
// V7: Axis width shrink hysteresis (prevent oscillation)
const AXIS_WIDTH_SHRINK_DELAY_MS = 500;  // Delay before shrinking axis width
const AXIS_WIDTH_SHRINK_THRESHOLD_PX = 8;  // Minimum change required to shrink
const GRID_MINOR_MIN_SPACING = 20;
const GRID_MINOR_FADE_SPACING = 100;
const GRID_MINOR_ALPHA_MIN = 0;
const GRID_MINOR_ALPHA_MAX = 0.45;
const GRID_PANE_DIVIDER_ALPHA = 0.5;
const EMPTY_DASH: number[] = [];
const MIN_VISIBLE_BARS_DEFAULT = 3;
const STEP_SAMPLE_MAX = 128;
const STEP_PERCENTILE = 0.5;
const SERIES_STEP_PERCENTILE = 0.5;
const PANE_RESIZE_HANDLE_PX = 8;
const PANE_MIN_HEIGHT_PX = 80;
const TIME_AXIS_HEIGHT_PX = 32;
const AXIS_DRAG_SENSITIVITY = 0.0035;
const AXIS_DRAG_MIN_SCALE = 0.1;
const AXIS_DRAG_MAX_SCALE = 10;
const AXIS_DRAG_MIN_LOG_SPAN = 1e-6;
const WHEEL_LINE_HEIGHT_PX = 16;
const WHEEL_PAGE_HEIGHT_FALLBACK = 800;
const WHEEL_TRACKPAD_THRESHOLD = 45;
const WHEEL_MAX_DELTA_PX = 240;
const WHEEL_ZOOM_SCALE_MOUSE = 0.7;
const WHEEL_ZOOM_SCALE_PINCH = 0.4;
const INTERACTION_IDLE_MS = 140;
const INTERACTION_BUDGET_MS = 8;
const QUALITY_HOLD_FRAMES = 4;
const AXIS_DAMP_EXPAND = 0.35;
const AXIS_DAMP_SHRINK = 0.12;
const LAST_VALUE_ANIMATION_MS = 180;

const pow2Ceil = (value: number): number => {
  const safe = Math.max(1, Math.floor(value));
  return Math.pow(2, Math.ceil(Math.log2(safe)));
};

const resolveAxisBucketSize = (length: number): number => {
  if (!Number.isFinite(length) || length <= 0) return AXIS_BUCKET_SIZE;
  const raw = Math.ceil(length / AXIS_BUCKET_TARGET_COUNT);
  const size = Math.max(AXIS_BUCKET_SIZE, raw);
  return Math.max(AXIS_BUCKET_SIZE, pow2Ceil(size));
};

type LineRenderMode = 'direct' | 'path2d';

let cachedLineRenderMode: LineRenderMode | null = null;

const resolveLineRenderMode = (root: HTMLElement): LineRenderMode => {
  if (cachedLineRenderMode) return cachedLineRenderMode;
  if (!root.hasAttribute('data-debug-path2d')) {
    cachedLineRenderMode = 'direct';
    return cachedLineRenderMode;
  }
  if (typeof document === 'undefined' || typeof performance === 'undefined') {
    cachedLineRenderMode = 'direct';
    return cachedLineRenderMode;
  }
  if (typeof Path2D === 'undefined') {
    cachedLineRenderMode = 'direct';
    return cachedLineRenderMode;
  }

  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    cachedLineRenderMode = 'direct';
    return cachedLineRenderMode;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const points = 5_000;
  const time = new Float64Array(points);
  const value = new Float64Array(points);
  for (let i = 0; i < points; i += 1) {
    time[i] = i;
    value[i] = Math.sin(i / 20) * 40 + Math.cos(i / 11) * 18 + 100;
  }

  const surface: SnapSurface = {
    snapX: (x: number) => x,
    snapY: (y: number) => y,
    alignLineWidth: (width: number) => width,
  };
  const plotRect = { x: 0, y: 0, width: 800, height: 400 };
  const priceScale = new PriceScale({ tickCount: 6, format: 'decimal' });
  priceScale.setRange(0, 200, 1);
  priceScale.setHeight(plotRect.height);
  const renderInput = {
    ctx,
    surface,
    plotRect,
    visibleRange: { from: 0, to: points - 1 },
    time,
    value,
    priceScale,
    options: { width: 2 },
    defaultColor: '#000000',
  };

  const run = (usePath2D: boolean): number => {
    const iterations = 3;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      ctx.clearRect(0, 0, plotRect.width, plotRect.height);
      renderLineSeries({ ...renderInput, usePath2D });
    }
    return performance.now() - start;
  };

  const directTime = run(false);
  const pathTime = run(true);

  cachedLineRenderMode = pathTime < directTime ? 'path2d' : 'direct';
  return cachedLineRenderMode;
};

const alignToDevicePixel = (value: number, dpr: number): number => {
  if (!Number.isFinite(value)) return value;
  const scale = Math.max(1, dpr || 1);
  return Math.round(value * scale) / scale;
};

const createSnapSurface = (dpr: number, stabilizer?: CoordinateStabilizer): SnapSurface => {
  const safeDpr = Math.max(1, dpr || 1);
  const alignLineWidth = (width: number): number => {
    if (!Number.isFinite(width)) return width;
    const deviceWidth = Math.max(1, Math.round(width * safeDpr));
    return deviceWidth / safeDpr;
  };
  const snap = (value: number, strokeWidth = 1): number => {
    const aligned = alignToDevicePixel(value, safeDpr);
    const safeWidth = Number.isFinite(strokeWidth) ? strokeWidth : 1;
    const deviceWidth = Math.max(1, Math.round(safeWidth * safeDpr));
    const needsHalfPixel = deviceWidth % 2 === 1;
    const snapped = needsHalfPixel ? aligned + 0.5 / safeDpr : aligned;

    // V8: Anti-jitter during pan
    // If panning, return raw value (float) to prevent aliasing artifacts (jitter).
    // The visual smoothness of motion blur is preferred over unwanted pixel jumping.
    if (stabilizer && stabilizer.isPanActive()) {
      return value;
    }

    return snapped;
  };
  return {
    snapX: snap,
    snapY: snap,
    alignLineWidth,
  };
};

const createLodWorker = (): Worker | null => {
  const factory = getLodWorkerFactory();
  return factory ? factory() : null;
};

const supportsSeriesWorker = (): boolean => {
  if (!getSeriesWorkerFactory()) return false;
  if (typeof Worker === 'undefined') return false;
  if (typeof Blob === 'undefined' || typeof URL === 'undefined') return false;
  if (typeof OffscreenCanvas === 'undefined') return false;
  if (typeof HTMLCanvasElement === 'undefined') return false;
  return 'transferControlToOffscreen' in HTMLCanvasElement.prototype;
};

const createSeriesWorker = (): Worker | null => {
  const factory = getSeriesWorkerFactory();
  return factory ? factory() : null;
};

const resolveLodBucketSizes = (length: number, maxLevels: number): number[] => {
  if (length <= 1) return [];
  const levelCount = Math.max(0, Math.min(maxLevels, Math.floor(Math.log2(length))));
  return Array.from({ length: levelCount }, (_, index) => Math.pow(2, index + 1));
};

const scheduleChunk = (cb: () => void): void => {
  const idle = (globalThis as { requestIdleCallback?: (handler: () => void) => number })
    .requestIdleCallback;
  if (typeof idle === 'function') {
    idle(cb);
  } else {
    setTimeout(cb, 0);
  }
};

const canUseSharedArrayBuffer = (): boolean => {
  const global = globalThis as { crossOriginIsolated?: boolean };
  return typeof SharedArrayBuffer !== 'undefined' && global.crossOriginIsolated === true;
};

const copyToSharedArray = (source: Float64Array, length: number): Float64Array => {
  const safeLength = Math.max(0, Math.floor(length));
  const buffer = new SharedArrayBuffer(safeLength * Float64Array.BYTES_PER_ELEMENT);
  const target = new Float64Array(buffer);
  if (safeLength > 0) {
    target.set(source.subarray(0, safeLength));
  }
  return target;
};

const buildLodLevelChunked = (
  time: Float64Array,
  value: Float64Array,
  length: number,
  bucketSize: number,
  token: CancellableToken,
): Promise<LodWorkerLevel | null> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (level: LodWorkerLevel | null) => {
      if (settled) return;
      settled = true;
      resolve(level);
    };

    const bucketCount = Math.ceil(length / bucketSize);
    const outTime: number[] = [];
    const outValue: number[] = [];
    const offsets = new Int32Array(bucketCount + 1);
    const bucketsPerChunk = Math.max(1, Math.floor(LOD_CHUNK_POINTS / bucketSize));
    let bucketIndex = 0;

    const processChunk = () => {
      if (token.canceled) {
        finish(null);
        return;
      }

      const endBucket = Math.min(bucketCount, bucketIndex + bucketsPerChunk);
      for (; bucketIndex < endBucket; bucketIndex += 1) {
        offsets[bucketIndex] = outTime.length;
        const start = bucketIndex * bucketSize;
        const end = Math.min(length, start + bucketSize);
        let hasFinite = false;
        let firstIndex = -1;
        let lastIndex = -1;
        let minIndex = -1;
        let maxIndex = -1;
        let minValue = 0;
        let maxValue = 0;
        let firstNaNIndex = -1;

        for (let i = start; i < end; i += 1) {
          const v = value[i]!;
          if (Number.isNaN(v)) {
            if (firstNaNIndex < 0) firstNaNIndex = i;
            continue;
          }
          if (!hasFinite) {
            hasFinite = true;
            firstIndex = i;
            lastIndex = i;
            minIndex = i;
            maxIndex = i;
            minValue = v;
            maxValue = v;
          } else {
            lastIndex = i;
            if (v < minValue) {
              minValue = v;
              minIndex = i;
            }
            if (v > maxValue) {
              maxValue = v;
              maxIndex = i;
            }
          }
        }

        if (!hasFinite) {
          if (firstNaNIndex >= 0) {
            outTime.push(time[firstNaNIndex]!);
            outValue.push(Number.NaN);
          }
          continue;
        }

        const indices = [firstIndex, minIndex, maxIndex, lastIndex];
        if (firstNaNIndex >= 0) indices.push(firstNaNIndex);
        indices.sort((a, b) => a - b);
        let previous = -1;
        for (let i = 0; i < indices.length; i += 1) {
          const idx = indices[i]!;
          if (idx === previous) continue;
          outTime.push(time[idx]!);
          outValue.push(value[idx]!);
          previous = idx;
        }
      }

      if (bucketIndex < bucketCount) {
        scheduleChunk(processChunk);
        return;
      }

      offsets[bucketCount] = outTime.length;
      finish({
        bucketSize,
        time: Float64Array.from(outTime),
        value: Float64Array.from(outValue),
        length: outTime.length,
        offsets,
      });
    };

    scheduleChunk(processChunk);
  });

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container === 'string') {
    const el = document.getElementById(container);
    if (!el) throw new Error(`Cannot find element with id="${container}"`);
    return el;
  }
  return container;
}

function compileTheme(tokens: ThemeTokens): PaintStyles {
  const fontSizePx = Math.max(10, Math.round(tokens.fontSizePx));
  const font = `${fontSizePx}px ${tokens.fontFamily}`;
  const axisPadding = Math.max(10, Math.round(fontSizePx * 0.75));
  return {
    background: tokens.background,
    gridMajor: tokens.gridMajor,
    gridMinor: tokens.gridMinor,
    axisText: tokens.axisText,
    crosshair: '#fc7432', // V8 Update: Use requested aesthetic orange
    focusBand: tokens.focusBand,
    fontFamily: tokens.fontFamily,
    fontSizePx,
    font,
    axisPadding,
    seriesPalette: [
      tokens.seriesPrimary,
      tokens.seriesSecondary,
      tokens.seriesTertiary,
      tokens.seriesQuaternary,
      tokens.seriesQuinary,
    ],
  };
}

const normalizeWatermarkOptions = (
  options: WatermarkOptions | null | undefined,
): WatermarkOptions | null => {
  if (!options) return null;
  const text = typeof options.text === 'string' ? options.text.trim() : undefined;
  const imageSrc = typeof options.imageSrc === 'string' ? options.imageSrc.trim() : undefined;
  if (!text && !imageSrc) return null;
  const next: WatermarkOptions = { ...options };
  if (text) {
    next.text = text;
  } else {
    delete next.text;
  }
  if (imageSrc) {
    next.imageSrc = imageSrc;
  } else {
    delete next.imageSrc;
  }
  if (typeof options.opacity === 'number' && Number.isFinite(options.opacity)) {
    next.opacity = clamp(options.opacity, 0, 1);
  }
  if (typeof options.fontSizePx === 'number' && Number.isFinite(options.fontSizePx)) {
    next.fontSizePx = Math.max(6, Math.round(options.fontSizePx));
  }
  if (typeof options.imageWidth === 'number' && Number.isFinite(options.imageWidth)) {
    next.imageWidth = Math.max(1, Math.round(options.imageWidth));
  }
  if (typeof options.imageHeight === 'number' && Number.isFinite(options.imageHeight)) {
    next.imageHeight = Math.max(1, Math.round(options.imageHeight));
  }
  if (options.position) {
    const allowed = new Set([
      'center',
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ]);
    next.position = allowed.has(options.position) ? options.position : 'center';
  }
  return next;
};

const resolveTimeFormatter = (
  formatter: ((time: TimeMs) => string) | undefined,
  timeZone: TimeZone,
  timeScaleOptions?: {
    timeVisible?: boolean;
    secondsVisible?: boolean;
    tickMarkFormatter?: (time: TimeMs) => string;
  },
): ((time: TimeMs) => string) => {
  if (formatter) return formatter;
  if (typeof timeScaleOptions?.tickMarkFormatter === 'function') {
    return timeScaleOptions.tickMarkFormatter;
  }
  const hasExplicitVisibility =
    timeScaleOptions?.timeVisible !== undefined || timeScaleOptions?.secondsVisible !== undefined;
  if (hasExplicitVisibility) {
    const showTime = timeScaleOptions?.timeVisible ?? true;
    const showSeconds = timeScaleOptions?.secondsVisible ?? true;
    const useUtc = timeZone === 'utc';
    const pad2 = (value: number) => `${Math.floor(value)}`.padStart(2, '0');
    return (time) => {
      if (!Number.isFinite(time)) return '';
      const date = new Date(time);
      const year = useUtc ? date.getUTCFullYear() : date.getFullYear();
      const month = (useUtc ? date.getUTCMonth() : date.getMonth()) + 1;
      const day = useUtc ? date.getUTCDate() : date.getDate();
      if (!showTime) {
        return `${year}-${pad2(month)}-${pad2(day)}`;
      }
      const hours = useUtc ? date.getUTCHours() : date.getHours();
      const minutes = useUtc ? date.getUTCMinutes() : date.getMinutes();
      if (!showSeconds) {
        return `${pad2(hours)}:${pad2(minutes)}`;
      }
      const seconds = useUtc ? date.getUTCSeconds() : date.getSeconds();
      return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
    };
  }
  const tz = timeZone === 'utc' ? 'UTC' : undefined;
  if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
    const dateTime = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: tz,
    });
    return (time) => (Number.isFinite(time) ? dateTime.format(new Date(time)) : '');
  }
  return (time) => (Number.isFinite(time) ? new Date(time).toISOString() : '');
};

const EXPORT_DEFAULT_LOCALE = 'en-US';
const EXPORT_DEFAULT_FONT_FAMILY = '"Arial", "Helvetica", sans-serif';
const FOCUS_STYLE_ID = 'charts-plus-focus-style';
const FOCUS_RING_COLOR = 'rgba(89, 145, 255, 0.85)';

const resolveExportTimeFormatter = (
  locale: string,
  timeZone: TimeZone,
): ((time: TimeMs) => string) => {
  const tz = timeZone === 'utc' ? 'UTC' : undefined;
  if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
    const dateTime = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: tz,
    });
    return (time) => (Number.isFinite(time) ? dateTime.format(new Date(time)) : '');
  }
  return (time) => (Number.isFinite(time) ? new Date(time).toISOString() : '');
};

const ensureFocusStyles = (): void => {
  if (typeof document === 'undefined') return;
  if (document.getElementById(FOCUS_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FOCUS_STYLE_ID;
  style.textContent = `
    .charts-plus-root:focus,
    .charts-plus-root:focus-visible {
      outline: 2px solid var(--charts-plus-focus-ring, ${FOCUS_RING_COLOR});
      outline-offset: 2px;
    }
  `;
  document.head.appendChild(style);
};

const ensureAccessibilityBaseline = (root: HTMLElement): void => {
  ensureFocusStyles();
  root.classList.add('charts-plus-root');
  if (!root.hasAttribute('tabindex')) {
    root.tabIndex = 0;
  }
  if (!root.hasAttribute('role')) {
    root.setAttribute('role', 'region');
  }
  if (!root.hasAttribute('aria-label') && !root.hasAttribute('aria-labelledby')) {
    root.setAttribute('aria-label', 'Charts+ interactive chart');
  }
};

let nextSeriesId = 1;

type ChartFactoryOverrides = {
  createScale?: (data: DataStore, initialRange: VisibleTimeRange) => HorizontalScale;
};

export type NumericChartOptions = CreateChartOptions & {
  xScale?: NumericScaleOptions;
  xFormatter?: (value: number) => string;
};

export type YieldCurveChartOptions = NumericChartOptions;
export type OptionsChartOptions = NumericChartOptions;

const DEFAULT_YIELD_TICK_STEPS = [1, 2, 3, 6, 12, 24, 36, 60, 120, 240, 360];
const DEFAULT_NUMERIC_MAX_RANGE = Number.MAX_SAFE_INTEGER;

let cachedNumberFormatter: Intl.NumberFormat | null = null;

const formatNumericValue = (value: number, maxDecimals = 2): string => {
  if (!Number.isFinite(value)) return '';
  if (typeof Intl !== 'undefined' && typeof Intl.NumberFormat === 'function') {
    if (!cachedNumberFormatter || cachedNumberFormatter.resolvedOptions().maximumFractionDigits !== maxDecimals) {
      cachedNumberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: maxDecimals });
    }
    return cachedNumberFormatter.format(value);
  }
  const factor = Math.pow(10, maxDecimals);
  const rounded = Math.round(value * factor) / factor;
  return String(Number(rounded.toFixed(maxDecimals)));
};

const formatTenorMonths = (value: number): string => {
  if (!Number.isFinite(value)) return '';
  const sign = value < 0 ? '-' : '';
  const absValue = Math.abs(value);
  if (absValue < 12) {
    return `${sign}${formatNumericValue(absValue, 2)}M`;
  }
  const years = absValue / 12;
  return `${sign}${formatNumericValue(years, 2)}Y`;
};

const resolveNumericScaleOptions = (
  options: NumericChartOptions,
  defaults: Partial<NumericScaleOptions> = {},
): NumericScaleOptions => {
  const timeScale = options.timeScale ?? {};
  const sharedOptions: Partial<NumericScaleOptions> = {};
  if (timeScale.minRangeMs !== undefined) sharedOptions.minRangeMs = timeScale.minRangeMs;
  if (timeScale.maxRangeMs !== undefined) sharedOptions.maxRangeMs = timeScale.maxRangeMs;
  if (timeScale.clampToData !== undefined) sharedOptions.clampToData = timeScale.clampToData;
  if (timeScale.paddingMs !== undefined) sharedOptions.paddingMs = timeScale.paddingMs;
  if (timeScale.elasticClamp !== undefined) sharedOptions.elasticClamp = timeScale.elasticClamp;
  if (timeScale.elasticMaxRatio !== undefined) {
    sharedOptions.elasticMaxRatio = timeScale.elasticMaxRatio;
  }
  if (timeScale.fixLeftEdge !== undefined) sharedOptions.fixLeftEdge = timeScale.fixLeftEdge;
  if (timeScale.fixRightEdge !== undefined) sharedOptions.fixRightEdge = timeScale.fixRightEdge;
  const scaleOptions = { ...defaults, ...sharedOptions, ...(options.xScale ?? {}) };
  if (scaleOptions.maxRangeMs === undefined) {
    scaleOptions.maxRangeMs = DEFAULT_NUMERIC_MAX_RANGE;
  }
  return scaleOptions;
};

export function createChart(
  container: HTMLElement | string,
  options: CreateChartOptions = {},
  overrides: ChartFactoryOverrides = {},
): Chart {
  // Install debug API globally (window.__chartsPlusDebug)
  installDebugAPI();

  const root = resolveContainer(container);
  const createScale = overrides.createScale;
  const hasCustomScale = typeof createScale === 'function';

  let theme = normalizeThemeTokens();
  let paint = compileTheme(theme);
  let themeVersion = 0;
  const lineRenderMode = resolveLineRenderMode(root);
  const usePath2D = lineRenderMode === 'path2d';
  const debugRps = root.hasAttribute('data-debug-rps');
  if (typeof window !== 'undefined') {
    const position = window.getComputedStyle(root).position;
    if (position === 'static') {
      root.style.position = 'relative';
    }
  }
  root.style.overflow = 'hidden';
  ensureAccessibilityBaseline(root);

  const seriesRendererMode: SeriesRendererMode = options.seriesRenderer ?? 'main';
  const fastContextAttributes: CanvasRenderingContext2DSettings = { desynchronized: true };
  const surfaceOptions: { autoSize?: boolean; width?: number; height?: number } = {};
  if (options.autoSize !== undefined) surfaceOptions.autoSize = options.autoSize;
  if (options.width !== undefined) surfaceOptions.width = options.width;
  if (options.height !== undefined) surfaceOptions.height = options.height;

  // V7: Opaque Layers - Only background (underlay) is opaque, all others need alpha for compositing
  const underlay = new CanvasSurface(root, {
    ...surfaceOptions,
    autoSize: false,
    absolute: true,
    zIndex: 0,
    pointerEvents: 'none',
    contextAttributes: {
      alpha: false,  // V7: Opaque - will fill with background color (not black!)
      desynchronized: true
    },
  });
  const seriesLayer = new CanvasSurface(root, {
    ...surfaceOptions,
    autoSize: false,
    absolute: true,
    zIndex: 1,
    pointerEvents: 'none',
    deferContext: seriesRendererMode !== 'main',
    contextAttributes: { alpha: true },  // V7: Needs alpha - composites on top of underlay
  });
  const panLayer = new CanvasSurface(root, {
    ...surfaceOptions,
    autoSize: false,
    absolute: true,
    zIndex: 2,
    pointerEvents: 'none',
    contextAttributes: {
      alpha: true,  // V7: Needs alpha - blitted on top of other layers
      ...fastContextAttributes
    },
  });
  const overlay = new CanvasSurface(root, {
    ...surfaceOptions,
    autoSize: false,
    absolute: true,
    zIndex: 3,
    pointerEvents: 'auto',
    contextAttributes: {
      alpha: true,  // V7: Needs alpha - crosshair on top of everything
      ...fastContextAttributes
    },
  });
  overlay.canvas.style.touchAction = 'none';

  // V8: Removed setPanStabilization — toggling snapping state during pan
  // causes bars near pixel boundaries to shift inconsistently.
  // Smooth panning is achieved via sub-pixel cache blit instead.

  // V7: DPR change detection - monitor when window moves between displays
  let currentDpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  const checkDprChange = (): boolean => {
    if (typeof window === 'undefined') return false;
    const newDpr = window.devicePixelRatio;
    if (newDpr !== currentDpr) {
      currentDpr = newDpr;
      // DPR changed - trigger resize to recalculate effective DPR
      const size = underlay.getSize();
      underlay.resize(size.cssWidth, size.cssHeight);
      seriesLayer.resize(size.cssWidth, size.cssHeight);
      panLayer.resize(size.cssWidth, size.cssHeight);
      overlay.resize(size.cssWidth, size.cssHeight);
      invalidate(InvalidationFlag.All);
      return true;
    }
    return false;
  };

  let destroyed = false;
  let hasCustomVisibleRange = false;
  let autoScrollEnabled = options.autoScroll ?? false;
  const seriesList: InternalSeries[] = [];
  const histogramColorBySeries = new Map<string, Map<TimeMs, string>>();
  const plugins: ChartPlugin<CanvasRenderingContext2D>[] = [];

  // V6: Indicator tracking
  type IndicatorInstance = {
    id: string;
    type: string;
    params: Record<string, any>;
    sourceSeries: InternalSeries | null;
    series: LineSeries[];
    computation: any; // IndicatorComputation instance
  };
  const indicators = new Map<string, IndicatorInstance>();
  const crosshairListeners = new Set<(ev: CrosshairMoveEvent) => void>();
  const visibleRangeListeners = new Set<(range: VisibleTimeRange) => void>();
  let seriesRenderRevision = 0;
  const layoutEngine = new LayoutEngine();
  const labelCache = new LabelMeasureCache();
  let axisOptions: { left?: Parameters<PriceScale['setOptions']>[0]; right?: Parameters<PriceScale['setOptions']>[0] } =
    options.axis ? { ...options.axis } : {};
  let axisPillWidthLeft = 0;
  let axisPillWidthRight = 0;
  let cachedAxisWidthLeft = 0;
  let cachedAxisWidthRight = 0;
  let cachedAxisLabelSpacing = 0;
  // V7: Axis width shrink hysteresis - track shrink intent with delay
  let axisWidthShrinkTimerLeft: number | null = null;
  let axisWidthShrinkTimerRight: number | null = null;
  let pendingShrinkWidthLeft: number | null = null;
  let pendingShrinkWidthRight: number | null = null;
  let cachedTimeLabelWidth = 0;
  let cachedTimeTicks: { range: VisibleTimeRange; ticks: number[]; count: number } | null = null;
  let lastValueDirty = false;
  const createAxisScale = (axisOption?: Parameters<PriceScale['setOptions']>[0]): PriceScale =>
    new PriceScale({
      tickCount: 6,
      format: 'decimal',
      ...axisOption,
    });
  const paneList: InternalPane[] = [];
  const paneById = new Map<PaneId, InternalPane>();
  const paneSeriesMap = new Map<PaneId, InternalSeries[]>();
  const paneHeightsById = new Map<PaneId, number>();
  const paneResizeOptions = options.panes?.resize ?? {};
  const paneResizeEnabled = paneResizeOptions.enabled ?? false;
  const paneResizeHandlePx = Math.max(
    4,
    Math.round(paneResizeOptions.handleHeightPx ?? PANE_RESIZE_HANDLE_PX),
  );
  const paneMinHeightPx = Math.max(24, Math.round(paneResizeOptions.minHeightPx ?? PANE_MIN_HEIGHT_PX));
  let paneResizeActive:
    | {
      index: number;
      startY: number;
      topId: PaneId;
      bottomId: PaneId;
      topHeight: number;
      bottomHeight: number;
    }
    | null = null;
  let nextPaneId = 1;
  const defaultPaneId: PaneId = 'pane-0';
  const createPaneHandle = (pane: InternalPane): PaneApi => ({
    id: pane.id,
    setHeight: (height: number) => {
      if (!Number.isFinite(height)) return;
      const nextHeight = Math.max(paneMinHeightPx, Math.round(height));
      pane.fixedHeight = nextHeight;
      invalidate(InvalidationFlag.Layout);
    },
    getHeight: () => paneHeightsById.get(pane.id) ?? pane.fixedHeight ?? null,
    setStretchFactor: (stretchFactor: number) => {
      if (!Number.isFinite(stretchFactor)) return;
      const nextFactor = Math.max(0.01, stretchFactor);
      pane.stretchFactor = nextFactor;
      pane.fixedHeight = null;
      invalidate(InvalidationFlag.Layout);
    },
    getStretchFactor: () => pane.stretchFactor,
    setVisible: (visible: boolean) => {
      if (pane.id === defaultPaneId) return;
      pane.visible = visible;
      invalidatePanCache();
      invalidate(InvalidationFlag.Layout);
    },
    isVisible: () => pane.id === defaultPaneId ? true : pane.visible,
    moveTo: (index: number) => {
      const currentIndex = paneList.indexOf(pane);
      if (currentIndex < 0) return;
      const targetIndex = clamp(Math.round(index), 0, paneList.length - 1);
      if (targetIndex === currentIndex) return;
      paneList.splice(currentIndex, 1);
      paneList.splice(targetIndex, 0, pane);
      invalidate(InvalidationFlag.Layout);
    },
    setPreserveEmptyPane: (preserve: boolean) => {
      pane.preserveEmpty = preserve;
      invalidate(InvalidationFlag.Layout);
    },
    preserveEmptyPane: () => pane.preserveEmpty,
  });

  const createPane = (id: PaneId, preserveEmpty = true): InternalPane => {
    const pane: InternalPane = {
      id,
      leftScale: createAxisScale(axisOptions.left),
      rightScale: createAxisScale(axisOptions.right),
      stretchFactor: 1,
      fixedHeight: null,
      preserveEmpty,
      visible: true,
      handle: null as unknown as PaneApi,
    };
    pane.handle = createPaneHandle(pane);
    return pane;
  };
  const defaultPane = createPane(defaultPaneId, false);
  paneList.push(defaultPane);
  paneById.set(defaultPaneId, defaultPane);
  paneSeriesMap.set(defaultPaneId, []);
  const memoryBudgets = options.memory ?? {};
  const decimator = new LineDecimator({
    maxEntries: 64,
    maxBytes: memoryBudgets.decimatorBytes ?? DEFAULT_DECIMATOR_BYTES,
  });
  const ohlcDecimator = new OhlcDecimator({
    maxEntries: 64,
    maxBytes: memoryBudgets.decimatorBytes ?? DEFAULT_DECIMATOR_BYTES,
  });
  const chunkedDecimator = new ChunkedLineDecimator({
    maxEntries: 64,
    maxBytes: memoryBudgets.decimatorBytes ?? DEFAULT_DECIMATOR_BYTES,
  });
  const timeBounds = new DataStore(2);
  const timeScaleOptions = options.timeScale ?? {};
  const userMinRangeMs = timeScaleOptions.minRangeMs;
  const minVisibleBars =
    typeof timeScaleOptions.minVisibleBars === 'number' &&
      Number.isFinite(timeScaleOptions.minVisibleBars) &&
      timeScaleOptions.minVisibleBars > 0
      ? Math.max(1, Math.round(timeScaleOptions.minVisibleBars))
      : MIN_VISIBLE_BARS_DEFAULT;
  const barSpacingPx =
    typeof timeScaleOptions.barSpacing === 'number' &&
      Number.isFinite(timeScaleOptions.barSpacing) &&
      timeScaleOptions.barSpacing > 0
      ? timeScaleOptions.barSpacing
      : null;
  const rightOffsetBars =
    typeof timeScaleOptions.rightOffset === 'number' &&
      Number.isFinite(timeScaleOptions.rightOffset) &&
      timeScaleOptions.rightOffset > 0
      ? timeScaleOptions.rightOffset
      : 0;
  const fitContentEnabled = timeScaleOptions.fitContent ?? false;
  const lockVisibleTimeRangeOnResize = timeScaleOptions.lockVisibleTimeRangeOnResize ?? false;
  const xScale: HorizontalScale = createScale
    ? createScale(timeBounds, { from: 0, to: 1 })
    : new TimeScale(timeBounds, { from: 0, to: 1 }, timeScaleOptions);
  const timeZone = options.timeZone ?? 'utc';
  const formatTime = resolveTimeFormatter(options.timeFormatter, timeZone, timeScaleOptions);
  let timeBoundsRange: VisibleTimeRange | null = null;
  let timeBoundsAppliedRange: VisibleTimeRange | null = null;
  let lastEmittedRange: VisibleTimeRange | null = null;
  let autoMinRangeMs: number | null = null;
  let lastTimeStepMs: number | null = null;
  let layoutState: LayoutResult | null = null;
  let paneStates: PaneState[] = [];
  let timeLabels: TimeLabel[] = [];
  const paneStateById = new Map<PaneId, PaneState>();
  let pendingResizeAdjust = false;

  let logTimer: number | null = null;
  let frameCount = 0;
  let layoutCount = 0;
  let underlayCount = 0;
  // Track last coherent snapshot for frame coherence (V7)
  // Coherent group: underlay (grid, axes) + series - must all use same snapshot
  // When both render together, store the snapshot; if one is skipped, they continue showing last coherent state
  let lastCoherentSnapshot: RenderStateSnapshot | null = null;
  let seriesCount = 0;
  let overlayCount = 0;
  type MemoryStats = {
    heap?: { used: number | null; total: number | null; limit: number | null };
    workingSet?: { bytes: number | null; measuredAt: number | null };
  };
  type RetentionStats = {
    rawRetentionMs: number | null;
    dataBytes: number;
    dataChunks: number;
    lodBytes: number;
    lodOnlyBytes: number;
    lodOnlyChunks: number;
  };
  type RenderStats = {
    frames: number;
    layout: number;
    series: number;
    overlay: number;
    underlay?: number;
    raf?: number;
    frameMsTotal?: number;
    frameMsMax?: number;
    frameMsLast?: number;
    axisLabelMeasures?: number;
    axisLabelDraws?: number;
    gridMajorLines?: number;
    gridMinorLines?: number;
    qualityLevel?: 0 | 1 | 2;
    lodMsFrame?: number;
    lodMsLast?: number;
    lodMsMax?: number;
    lodMsTotal?: number;
    lodOpsFrame?: number;
    lodOpsLast?: number;
    lodOpsMax?: number;
    lodOps?: number;
    retention?: RetentionStats;
    memory?: MemoryStats;
  };
  type WorkerQueueStats = { queueDepth: number; totalMs: number; completed: number };
  type WorkerStats = { lod: WorkerQueueStats; chunkLod: WorkerQueueStats };
  let dragPointerId: number | null = null;
  let dragLastX = 0;
  let dragLastY = 0;
  let paneResizePointerId: number | null = null;
  const activeTouches = new Map<number, { x: number; y: number }>();
  let lastTouchCenter: { x: number; y: number } | null = null;
  let lastTouchDistance = 0;
  let lastTouchCount = 0;
  type PanSource = 'mouse' | 'touch';
  let panVelocityX = 0;
  let lastPanTime = 0;
  let lastPanSource: PanSource | null = null;
  let lastPanX = 0;
  let lastPanY = 0;
  let panActive = false;
  let panOverscrollRaw = 0;
  let panOverscrollPx = 0;
  let panOverscrollReturnHandle: number | null = null;
  let panOverscrollReturnTimeout = false;
  let forceCoherentFrames = 0;
  let interactionActiveUntil = 0;
  let zoomInteractionUntil = 0;
  let renderQualityLevel: 0 | 1 | 2 = 0;
  let qualityHoldFrames = 0;
  let lastFrameCostMs = 0;
  let frameCostTotalMs = 0;
  let frameCostMaxMs = 0;
  let axisLabelMeasureCount = 0;
  let axisLabelDrawCount = 0;
  let gridMajorLineCount = 0;
  let gridMinorLineCount = 0;
  let lodWorkMsFrame = 0;
  let lodWorkMsLast = 0;
  let lodWorkMsTotal = 0;
  let lodWorkMsMax = 0;
  let lodWorkOps = 0;
  let lodWorkOpsFrame = 0;
  let lodWorkOpsLast = 0;
  let lodWorkOpsMax = 0;
  let workingSetPending = false;
  let lastWorkingSetBytes: number | null = null;

  // Y-axis ticks frozen during pan for stability (TradingView behavior)
  let frozenYTicksByPane = new Map<PaneId, Tick[]>();

  // Unified tick system state (Delta Grid Implementation)
  let useUnifiedTickSystem = true; // Feature flag for gradual rollout
  let gridTransitionManager: any = null; // Initialized when first used

  // Centralized tick coordinator - single source of truth for tick generation
  const tickCoordinator = new TickCoordinator();

  // Frame budget manager - ensures rendering stays within frame time limits
  const frameBudget = new FrameBudget();

  // Input coalescer - reduces render calls during fast panning
  const inputCoalescer = new InputCoalescer();

  // Quality transition manager - gradual quality level changes
  const qualityTransition = new QualityTransitionManager();

  // Frame timing monitor - comprehensive performance tracking (opt-in via data-debug-frame-timing)
  const frameTimingMonitor = new FrameTimingMonitor({
    enabled: root.hasAttribute('data-debug-frame-timing'),
    windowSize: 120, // 2 seconds at 60fps
    frameBudgetMs: 16.67, // 60fps
  });

  let gridOptions: GridOptions = {
    majorColor: '#2B2F36',
    majorOpacity: 0.8,
    minorColor: '#2B2F36',
    minorOpacity: 0.3,
    targetMajorPx: 80,
    enableCrossFade: true,
    useFinancialNice: true,
  };

  let lastWorkingSetAt: number | null = null;
  let wheelPanEndHandle: number | null = null;
  let inertiaHandle: number | null = null;
  let inertiaActive = false;
  let inertiaLastTime = 0;
  let crosshairActive = false;
  let crosshairPaneId: PaneId | null = null;
  let crosshairX = 0;
  let crosshairY = 0;
  let crosshairTime: number | null = null;
  let crosshairInGap = false;  // V7: Track if crosshair is in a gap (for visual indication)
  let crosshairShiftActive = false;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let hasPointerPosition = false;
  let pendingCrosshairEmit = false;
  let externalCrosshair: CrosshairState | null = null;
  let pendingExternalCrosshair: CrosshairState | null = null;
  let crosshairMode = options.crosshairMode ?? 'nearest';
  const gapThresholdMs =
    typeof options.gapThresholdMs === 'number' &&
      Number.isFinite(options.gapThresholdMs) &&
      options.gapThresholdMs > 0
      ? options.gapThresholdMs
      : null;
  const rawRetentionMs =
    typeof options.rawRetentionMs === 'number' &&
      Number.isFinite(options.rawRetentionMs) &&
      options.rawRetentionMs > 0
      ? options.rawRetentionMs
      : null;
  const retainLodOnly = rawRetentionMs !== null;
  let watermarkOptions = normalizeWatermarkOptions(options.watermark);
  let watermarkImage: HTMLImageElement | null = null;
  let watermarkImageReady = false;
  let watermarkImageSrc: string | null = null;
  let watermarkImageToken = 0;
  const lodOptions = {
    maxLevels: LOD_MAX_LEVELS,
    minPoints: LOD_MIN_POINTS,
    maxBytes: memoryBudgets.lodBytes ?? DEFAULT_LOD_BYTES,
  };
  const lodRetentionOptions = {
    maxLevels: LOD_MAX_LEVELS,
    minPoints: LOD_RETENTION_MIN_POINTS,
    maxBytes: memoryBudgets.lodBytes ?? DEFAULT_LOD_BYTES,
  };
  const chunkedLodBudget = memoryBudgets.lodBytes ?? DEFAULT_LOD_BYTES;
  let chunkedLodBytes = 0;
  let chunkedLodFrame = 0;
  const inertiaOptions = options.interaction?.inertia ?? {};
  const panOptions = options.interaction?.pan ?? {};
  const crosshairOptions = options.interaction?.crosshair ?? {};
  const resolveHandleScrollOptions = (
    input: HandleScrollOptions | boolean | undefined,
  ): Required<HandleScrollOptions> => {
    if (typeof input === 'boolean') {
      return {
        mouseWheel: input,
        pressedMouseMove: input,
        touchDrag: input,
      };
    }
    return {
      mouseWheel: input?.mouseWheel ?? true,
      pressedMouseMove: input?.pressedMouseMove ?? true,
      touchDrag: input?.touchDrag ?? true,
    };
  };
  const resolveHandleScaleOptions = (
    input: HandleScaleOptions | boolean | undefined,
  ): Required<HandleScaleOptions> => {
    if (typeof input === 'boolean') {
      return { mouseWheel: input, pinch: input, axisDrag: input };
    }
    return {
      mouseWheel: input?.mouseWheel ?? true,
      pinch: input?.pinch ?? true,
      axisDrag: input?.axisDrag ?? true,
    };
  };
  const handleScroll = resolveHandleScrollOptions(options.interaction?.handleScroll);
  const handleScale = resolveHandleScaleOptions(options.interaction?.handleScale);
  const handleScrollMouseWheel = handleScroll.mouseWheel;
  const handleScrollPressedMouseMove = handleScroll.pressedMouseMove;
  const handleScrollTouchDrag = handleScroll.touchDrag;
  const handleScaleMouseWheel = handleScale.mouseWheel;
  const handleScalePinch = handleScale.pinch;
  const handleScaleAxisDrag = handleScale.axisDrag;
  // V8 Fix: Pan cache disabled to resolve rendering inconsistencies during drag
  // The pan cache optimization (pre-rendering with overscan) caused:
  // 1. Bar width discrepancies near data boundaries (different point counts)
  // 2. Bar position shifts (different pixel alignment between cache and direct rendering)
  // Disabling the cache ensures consistent rendering at the cost of slightly higher CPU during pan.
  // To re-enable, restore: panOverscanRatio = panOptions.overscanRatio ?? PAN_OVERSCAN_RATIO
  const panOverscanRatio = 0;
  const panFreezeAxis = panOptions.freezeAxis ?? false;
  const panFreezeTicks = panOptions.freezeTicks ?? false;
  const panAxisSmoothing = panOptions.axisSmoothing ?? 'inertia';
  const panFreezeAxisThreshold =
    typeof panOptions.freezeAxisThreshold === 'number' && Number.isFinite(panOptions.freezeAxisThreshold)
      ? Math.max(0, Math.min(1, panOptions.freezeAxisThreshold))
      : null;
  const inertiaEnabled = inertiaOptions.enabled ?? true;
  // V5.2: iOS-like friction decay - 0.95 means 5% velocity loss per frame at 60fps
  // V6: Apply accessibility adjustments for reduced motion
  const baseFriction =
    typeof inertiaOptions.friction === 'number' && Number.isFinite(inertiaOptions.friction)
      ? Math.min(0.999, Math.max(0.5, inertiaOptions.friction))
      : 0.95;
  const inertiaFriction = adjustFrictionForAccessibility(baseFriction); // V5.2: iOS-like momentum feel
  // V5.2: Stop threshold - momentum stops when velocity drops below this
  // Higher than old 0.005 for cleaner, more decisive stops
  const inertiaMinVelocity =
    typeof inertiaOptions.minVelocity === 'number' && Number.isFinite(inertiaOptions.minVelocity)
      ? Math.max(0, inertiaOptions.minVelocity)
      : 0.5; // V5.2: Clean stop threshold
  // V5.2: Crosshair smoothing is optional (off by default for direct manipulation)
  // When enabled, provides smooth transitions in magnet/ohlc modes
  const crosshairSmoothingEnabled = crosshairOptions.smoothing ?? false;
  const crosshairSmoothingFactor =
    typeof crosshairOptions.smoothingFactor === 'number' && Number.isFinite(crosshairOptions.smoothingFactor)
      ? Math.max(0, Math.min(1, crosshairOptions.smoothingFactor))
      : 0.65; // Default matches previous behavior
  const seriesWorkerSupported = supportsSeriesWorker();
  const seriesWorkerRequested = seriesRendererMode !== 'main';
  let seriesWorker: Worker | null = null;
  let seriesWorkerActive = false;
  let seriesWorkerDisabled = false;
  let lodWorkerDisabled = false;
  const disableSeriesWorker = (): void => {
    if (seriesWorker) {
      seriesWorker.onerror = null;
      seriesWorker.onmessageerror = null;
      seriesWorker.terminate();
    }
    seriesWorker = null;
    seriesWorkerActive = false;
    seriesWorkerDisabled = true;
    seriesLayer.restoreContext();
    setSeriesLayerHidden(false);
    invalidate(InvalidationFlag.All);
  };
  const disableLodWorker = (): void => {
    if (lodWorker) {
      lodWorker.onerror = null;
      lodWorker.onmessageerror = null;
      lodWorker.terminate();
    }
    lodWorker = null;
    lodWorkerDisabled = true;

    if (lodRequests.size > 0) {
      const fallbackSeries = new Map<InternalSeries, number>();
      for (const request of lodRequests.values()) {
        const series = request.series;
        const data = series.data;
        if (isChunkedStore(data)) continue;
        if (series.lodVersion !== request.version) continue;
        fallbackSeries.set(series, Math.min(data.length, request.length));
      }
      lodRequests.clear();
      lodRequestTimes.clear();
      for (const [series, length] of fallbackSeries.entries()) {
        const data = series.data;
        if (isChunkedStore(data)) continue;
        const time = data.times();
        const value = data.values();
        const token: LodBuildToken = { version: series.lodVersion, length, canceled: false };
        if (series.lodBuildToken) {
          series.lodBuildToken.canceled = true;
        }
        series.lodBuildToken = token;
        void buildLodLevelsChunked(series, time, value, length, token).then(() => {
          if (token.canceled || series.lodVersion !== token.version) return;
          series.lodBuildToken = null;
        });
      }
    }

    if (chunkLodRequests.size > 0) {
      for (const request of chunkLodRequests.values()) {
        const { series, chunkStart } = request;
        if (!isChunkedStore(series.data)) continue;
        const entry = series.chunkLods.get(chunkStart);
        if (!entry) continue;
        entry.pendingRequestId = null;
        const chunk = findChunkByStartTime(series.data, chunkStart);
        if (!chunk) {
          resetChunkLodEntry(entry);
          continue;
        }
        startChunkLodBuild(series, chunk, entry);
      }
      chunkLodRequests.clear();
      chunkLodRequestTimes.clear();
    }
  };
  const pathCache = new Map<string, LinePathCacheEntry>();
  const panCaches = new Map<string, PanCacheState>();
  let panCacheActive = false;
  let panBaseRange: VisibleTimeRange | null = null;
  let zoomCacheCooldown = 0;
  let seriesLayerHidden = false;
  let frozenAxisRanges: Map<PaneId, AxisRangeSnapshot> | null = null;
  const axisSmoothing = new Map<PaneId, AxisRangeSnapshot>();
  const axisManualRanges = new Map<string, AxisManualRange>();
  const axisScaleBases = new Map<string, number | null>();
  let axisDragState: AxisDragState | null = null;
  let lodWorker: Worker | null | undefined;
  const lodRequests = new Map<
    number,
    { series: InternalSeries; version: number; length: number; levels: LodWorkerLevel[] }
  >();
  const lodRequestTimes = new Map<number, number>();
  const chunkLodRequests = new Map<number, ChunkLodRequest>();
  const chunkLodRequestTimes = new Map<number, number>();
  let lodWorkerTotalMs = 0;
  let lodWorkerCompleted = 0;
  let chunkLodWorkerTotalMs = 0;
  let chunkLodWorkerCompleted = 0;
  let lodRequestId = 0;
  let scheduleSeriesInvalidate = () => { };

  const normalizeRange = (range: VisibleTimeRange): VisibleTimeRange => {
    let { from, to } = range;
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return { from: 0, to: 1 };
    }
    if (to <= from) {
      to = from + 1;
    }
    return { from, to };
  };

  const rangeContains = (outer: VisibleTimeRange, inner: VisibleTimeRange): boolean =>
    outer.from <= inner.from && outer.to >= inner.to;

  const rangeIntersects = (a: VisibleTimeRange, b: VisibleTimeRange): boolean =>
    a.from <= b.to && a.to >= b.from;

  const clampRangeToExtents = (
    range: VisibleTimeRange,
    extents: VisibleTimeRange | null,
  ): VisibleTimeRange => {
    if (!extents) return range;
    const clamped = {
      from: Math.max(range.from, extents.from),
      to: Math.min(range.to, extents.to),
    };
    return normalizeRange(clamped);
  };

  const expandRange = (range: VisibleTimeRange, paddingMs?: number): VisibleTimeRange => {
    if (typeof paddingMs !== 'number' || !Number.isFinite(paddingMs) || paddingMs <= 0) {
      return normalizeRange(range);
    }
    return normalizeRange({ from: range.from - paddingMs, to: range.to + paddingMs });
  };

  const emitVisibleRangeChange = (): void => {
    const range = xScale.getVisibleRange();
    if (
      !lastEmittedRange ||
      lastEmittedRange.from !== range.from ||
      lastEmittedRange.to !== range.to
    ) {
      lastEmittedRange = { from: range.from, to: range.to };
      visibleRangeListeners.forEach((cb) => cb(lastEmittedRange!));
    }
  };

  const mergeDirtyRange = (series: InternalSeries, range: VisibleTimeRange): void => {
    if (!series.dirtyRange) {
      series.dirtyRange = { from: range.from, to: range.to };
      return;
    }
    series.dirtyRange = {
      from: Math.min(series.dirtyRange.from, range.from),
      to: Math.max(series.dirtyRange.to, range.to),
    };
  };

  const deriveRangeFromChunk = (chunk: { time: Float64Array; length: number }): VisibleTimeRange | null => {
    if (chunk.length <= 0) return null;
    const first = chunk.time[0] ?? Number.NaN;
    const last = chunk.time[chunk.length - 1] ?? Number.NaN;
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
    return normalizeRange({ from: first, to: last });
  };

  const getPathCacheEntry = (key: string): LinePathCacheEntry | undefined => {
    const cached = pathCache.get(key);
    if (!cached) return undefined;
    pathCache.delete(key);
    pathCache.set(key, cached);
    return cached;
  };

  const setPathCacheEntry = (key: string, entry: LinePathCacheEntry): void => {
    if (pathCache.has(key)) {
      pathCache.delete(key);
    }
    pathCache.set(key, entry);
    while (pathCache.size > PATH_CACHE_MAX_ENTRIES) {
      const oldestKey = pathCache.keys().next().value;
      if (oldestKey === undefined) break;
      pathCache.delete(oldestKey);
    }
  };

  const clearPathCache = (seriesId?: string): void => {
    if (!seriesId) {
      pathCache.clear();
      return;
    }
    const prefix = `${seriesId}|`;
    for (const key of pathCache.keys()) {
      if (key.startsWith(prefix)) {
        pathCache.delete(key);
      }
    }
  };

  const linePathCache: LinePathCache = {
    get: getPathCacheEntry,
    set: setPathCacheEntry,
  };

  const bumpSeriesRevision = (series?: InternalSeries): void => {
    seriesRenderRevision += 1;
    if (series) {
      series.renderRevision += 1;
      clearPathCache(series.id);
    } else {
      clearPathCache();
    }
    invalidatePanCache();
  };

  const resolveSeriesAxis = (axis?: AxisId): AxisId => (axis === 'right' ? 'right' : 'left');

  const resolveSeriesPane = (paneId?: PaneId): PaneId =>
    paneId && paneById.has(paneId) ? paneId : defaultPaneId;

  const getAxisOverrideKey = (paneId: PaneId, axis: AxisId): string => `${paneId}\0${axis}`;

  const getPanCacheKey = (paneId: PaneId, axis: AxisId): string => `${paneId}\0${axis}`;

  const isChunkedStore = (data: DataStore | ChunkedDataStore): data is ChunkedDataStore =>
    data instanceof ChunkedDataStore;

  const getPane = (paneId: PaneId): InternalPane => paneById.get(paneId) ?? defaultPane;

  const getAxisScale = (paneId: PaneId, axis: AxisId): PriceScale => {
    const pane = getPane(paneId);
    return axis === 'right' ? pane.rightScale : pane.leftScale;
  };

  const getAxisScaleForSeries = (series: InternalSeries): PriceScale =>
    getAxisScale(series.paneId, series.axis);

  const getAxisScaleBase = (paneId: PaneId, axis: AxisId): number | null =>
    axisScaleBases.get(getAxisOverrideKey(paneId, axis)) ?? null;

  const setAxisScaleBase = (paneId: PaneId, axis: AxisId, baseValue: number | null): void => {
    axisScaleBases.set(getAxisOverrideKey(paneId, axis), baseValue);
  };

  const hasAxisSeries = (paneId: PaneId, axis: AxisId): boolean =>
    (paneSeriesMap.get(paneId) ?? []).some((series) => series.visible && series.axis === axis);

  const getPaneSeries = (paneId: PaneId): InternalSeries[] => paneSeriesMap.get(paneId) ?? [];

  const hasVisibleSeries = (paneId: PaneId): boolean =>
    getPaneSeries(paneId).some((series) => series.visible);

  const resolveSeriesDataRange = (series: InternalSeries): VisibleTimeRange | null => {
    if (series.provider?.extents) {
      return series.provider.extents;
    }
    if (isChunkedStore(series.data)) {
      const first = series.data.getChunk(0);
      const last = series.data.getChunk(series.data.chunkCount - 1);
      let minTime = first?.startTime ?? Number.POSITIVE_INFINITY;
      let maxTime = last?.endTime ?? Number.NEGATIVE_INFINITY;
      if (retainLodOnly && series.chunkLods.size > 0) {
        for (const entry of series.chunkLods.values()) {
          if (!entry.lodOnly) continue;
          minTime = Math.min(minTime, entry.startTime);
          maxTime = Math.max(maxTime, entry.endTime);
        }
      }
      if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) return null;
      return { from: minTime, to: maxTime };
    }
    if (series.data.length === 0) return null;
    const times = series.data.times();
    const first = times[0];
    const last = times[series.data.length - 1];
    if (first === undefined || last === undefined) return null;
    return { from: first, to: last };
  };

  const computeDataRange = (): VisibleTimeRange | null => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (const series of seriesList) {
      if (!series.visible) continue;
      const range = resolveSeriesDataRange(series);
      if (!range) continue;
      if (range.from < min) min = range.from;
      if (range.to > max) max = range.to;
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min === max) {
      return { from: min, to: min + 1 };
    }
    return { from: min, to: max };
  };

  const buildStepSamples = (times: ArrayLike<number>, length: number): number[] => {
    if (!Number.isFinite(length) || length < 2) return [];
    const maxSamples = Math.max(1, STEP_SAMPLE_MAX);
    const stride = Math.max(1, Math.floor((length - 1) / maxSamples));
    const samples: number[] = [];
    let prev = times[0]!;
    for (let i = 1; i < length; i += stride) {
      const t = times[i]!;
      const delta = t - prev;
      if (Number.isFinite(delta) && delta > 0) {
        samples.push(delta);
      }
      prev = t;
    }
    return samples;
  };

  const estimateStepFromSamples = (samples: number[]): number | null => {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * STEP_PERCENTILE)));
    const percentile = sorted[idx]!;
    const step = percentile;
    return Number.isFinite(step) && step > 0 ? step : null;
  };

  const resetSeriesTimeStep = (series: InternalSeries, times?: ArrayLike<number>, length = 0): void => {
    series.timeStepMs = null;
    series.timeStepSamples = [];
    series.lastTimeMs = null;
    if (!times || length <= 0) return;
    series.lastTimeMs = times[length - 1] ?? null;
    series.timeStepSamples = buildStepSamples(times, length);
    series.timeStepMs = estimateStepFromSamples(series.timeStepSamples);
  };

  const pushStepSample = (series: InternalSeries, delta: number): void => {
    if (!Number.isFinite(delta) || delta <= 0) return;
    const samples = series.timeStepSamples;
    samples.push(delta);
    if (samples.length > STEP_SAMPLE_MAX) {
      samples.shift();
    }
    series.timeStepMs = estimateStepFromSamples(samples);
  };

  const extendSeriesTimeStepFromPoints = (series: InternalSeries, points: DataPoint[]): void => {
    if (points.length === 0) return;
    let prev = series.lastTimeMs;
    for (const point of points) {
      const t = point.t;
      if (prev !== null && Number.isFinite(prev)) {
        pushStepSample(series, t - prev);
      }
      prev = t;
    }
    if (prev !== null && Number.isFinite(prev)) {
      series.lastTimeMs = prev;
    }
  };

  const resolveAutoMinRangeMs = (): number | null => {
    const steps: number[] = [];
    for (const series of seriesList) {
      if (!series.visible) continue;
      if (!Number.isFinite(series.timeStepMs) || series.timeStepMs! <= 0) continue;
      steps.push(series.timeStepMs!);
    }
    if (steps.length === 0) return null;
    steps.sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(steps.length - 1, Math.floor((steps.length - 1) * SERIES_STEP_PERCENTILE)));
    const step = steps[idx]!;
    const intervalCount = Math.max(1, minVisibleBars - 1);
    return Math.max(1, step * intervalCount);
  };

  const resolveSeriesStepMs = (): number | null => {
    const steps: number[] = [];
    for (const series of seriesList) {
      if (!series.visible) continue;
      if (!Number.isFinite(series.timeStepMs) || series.timeStepMs! <= 0) continue;
      steps.push(series.timeStepMs!);
    }
    if (steps.length === 0) return null;
    steps.sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(steps.length - 1, Math.floor((steps.length - 1) * SERIES_STEP_PERCENTILE)));
    return steps[idx] ?? null;
  };

  const resolveRightOffsetMs = (stepMs: number | null): number => {
    if (!Number.isFinite(stepMs) || !stepMs || stepMs <= 0) return 0;
    if (rightOffsetBars <= 0) return 0;
    return rightOffsetBars * stepMs;
  };

  const resolveBarSpacingSpanMs = (plotWidth?: number, stepMs?: number | null): number | null => {
    if (!barSpacingPx || !Number.isFinite(barSpacingPx) || barSpacingPx <= 0) return null;
    if (!Number.isFinite(plotWidth) || !plotWidth || plotWidth <= 0) return null;
    if (!Number.isFinite(stepMs) || !stepMs || stepMs <= 0) return null;
    const bars = Math.max(1, Math.floor(plotWidth / barSpacingPx));
    return stepMs * bars;
  };

  const updateAutoMinRange = (): void => {
    if (userMinRangeMs !== undefined) return;
    const nextMin = resolveAutoMinRangeMs();
    if (nextMin === null) return;
    if (autoMinRangeMs !== null && Math.abs(autoMinRangeMs - nextMin) < 1e-6) return;
    autoMinRangeMs = nextMin;
    xScale.setOptions({ minRangeMs: nextMin });
  };

  const updateTimeBounds = (): VisibleTimeRange | null => {
    const dataRange = computeDataRange();
    if (!dataRange) {
      if (lastTimeStepMs !== null) {
        lastTimeStepMs = null;
        if ('setBarIntervalMs' in xScale && typeof (xScale as any).setBarIntervalMs === 'function') {
          (xScale as any).setBarIntervalMs(null);
        }
        tickCoordinator.invalidateAll();
      }
      return null;
    }
    const normalized = normalizeRange(dataRange);
    if (
      !timeBoundsRange ||
      timeBoundsRange.from !== normalized.from ||
      timeBoundsRange.to !== normalized.to
    ) {
      timeBoundsRange = normalized;
    }
    const rawStepMs = resolveSeriesStepMs();
    const stepMs =
      typeof rawStepMs === 'number' && Number.isFinite(rawStepMs) && rawStepMs > 0 ? rawStepMs : null;
    let invalidateTicks = false;
    const stepChanged =
      (stepMs === null) !== (lastTimeStepMs === null) ||
      (stepMs !== null && lastTimeStepMs !== null && Math.abs(stepMs - lastTimeStepMs) > 1e-6);
    if (stepChanged) {
      lastTimeStepMs = stepMs;
      if ('setBarIntervalMs' in xScale && typeof (xScale as any).setBarIntervalMs === 'function') {
        (xScale as any).setBarIntervalMs(stepMs);
      }
      invalidateTicks = true;
    }
    const rightOffsetMs = resolveRightOffsetMs(stepMs);
    const boundsRange = normalizeRange({ from: normalized.from, to: normalized.to + rightOffsetMs });
    if (
      !timeBoundsAppliedRange ||
      timeBoundsAppliedRange.from !== boundsRange.from ||
      timeBoundsAppliedRange.to !== boundsRange.to
    ) {
      timeBounds.setData([
        { t: boundsRange.from, v: 0 },
        { t: boundsRange.to, v: 0 },
      ]);
      timeBoundsAppliedRange = boundsRange;
      invalidateTicks = true;
    }
    if (invalidateTicks) {
      tickCoordinator.invalidateAll();
    }
    return normalized;
  };

  const resolveDefaultVisibleRange = (
    dataRange: VisibleTimeRange,
    plotWidth?: number,
  ): VisibleTimeRange => {
    const stepMs = resolveSeriesStepMs();
    const rightOffsetMs = resolveRightOffsetMs(stepMs);
    const fitRange = normalizeRange({ from: dataRange.from, to: dataRange.to + rightOffsetMs });
    if (fitContentEnabled) return fitRange;
    const span = resolveBarSpacingSpanMs(plotWidth, stepMs);
    if (!Number.isFinite(span) || (span ?? 0) <= 0) {
      return fitRange;
    }
    const to = dataRange.to + rightOffsetMs;
    return normalizeRange({ from: to - (span ?? 0), to });
  };

  const syncTimeScaleToData = (): void => {
    const dataRange = updateTimeBounds();
    const plotWidth = layoutState?.plotRect.width;
    updateAutoMinRange();
    if (!dataRange) return;
    const defaultRange = resolveDefaultVisibleRange(dataRange, plotWidth);
    if (autoScrollEnabled) {
      const current = xScale.getVisibleRange();
      let span = current.to - current.from;
      if (!Number.isFinite(span) || span <= 0) {
        span = defaultRange.to - defaultRange.from;
      }
      const next = normalizeRange({ from: defaultRange.to - span, to: defaultRange.to });
      xScale.setVisibleRange(next);
      hasCustomVisibleRange = true;
      emitVisibleRangeChange();
      return;
    }
    if (hasCustomVisibleRange) {
      xScale.setVisibleRange(xScale.getVisibleRange());
      emitVisibleRangeChange();
      return;
    }
    xScale.setVisibleRange(defaultRange);
    emitVisibleRangeChange();
  };

  const applyResizeTimeScaleAdjust = (plotWidth: number): void => {
    if (!pendingResizeAdjust) return;
    pendingResizeAdjust = false;
    if (lockVisibleTimeRangeOnResize) return;
    if (autoScrollEnabled || hasCustomVisibleRange) return;
    if (!fitContentEnabled && !barSpacingPx) return;
    const dataRange = timeBoundsRange ?? updateTimeBounds();
    if (!dataRange) return;
    const next = resolveDefaultVisibleRange(dataRange, plotWidth);
    xScale.setVisibleRange(next);
    emitVisibleRangeChange();
  };

  const resetLodState = (series: InternalSeries): void => {
    series.lodVersion += 1;
    if (series.lodBuildToken) {
      series.lodBuildToken.canceled = true;
      series.lodBuildToken = null;
    }
    series.lod.clear();
  };

  const applyDirtyRange = (series: InternalSeries, range: VisibleTimeRange): void => {
    const dirty = series.dirtyRange;
    if (!dirty || !rangeIntersects(dirty, range)) return;
    series.dirtyRange = null;
    if (isChunkedStore(series.data)) {
      return;
    }

    const store = series.data;
    decimator.clearCache();
    if (store.length < lodOptions.minPoints) return;
    if (series.lod.levels.length === 0) {
      if (store.length >= LOD_ASYNC_THRESHOLD) {
        startLodBuild(series);
      } else {
        withLodWork(() => series.lod.rebuild(store.times(), store.values(), store.length));
      }
      return;
    }
    withLodWork(() => series.lod.patchExisting(store.times(), store.values(), store.length, dirty));
  };

  const resolveChunkLastValue = (chunk: { value: Float64Array; length: number }): number => {
    if (chunk.length <= 0) return Number.NaN;
    return chunk.value[chunk.length - 1] ?? Number.NaN;
  };

  const buildChunkStats = (values: Float64Array, length: number): ChunkStats => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let minPositive = Number.POSITIVE_INFINITY;
    let mean = 0;
    let m2 = 0;
    let count = 0;
    let gapCount = 0;

    const end = Math.min(values.length, Math.max(0, Math.floor(length)));
    for (let i = 0; i < end; i += 1) {
      const v = values[i]!;
      if (!Number.isFinite(v)) {
        gapCount += 1;
        continue;
      }
      count += 1;
      if (count === 1) {
        min = v;
        max = v;
        if (v > 0) minPositive = v;
        mean = v;
        m2 = 0;
        continue;
      }
      min = Math.min(min, v);
      max = Math.max(max, v);
      if (v > 0) minPositive = Math.min(minPositive, v);
      const delta = v - mean;
      mean += delta / count;
      const delta2 = v - mean;
      m2 += delta * delta2;
    }

    if (count === 0) {
      return {
        min: Number.NaN,
        max: Number.NaN,
        minPositive: Number.NaN,
        mean: Number.NaN,
        variance: Number.NaN,
        count: 0,
        gapCount,
      };
    }

    return {
      min,
      max,
      minPositive: Number.isFinite(minPositive) ? minPositive : Number.NaN,
      mean,
      variance: count > 1 ? m2 / (count - 1) : 0,
      count,
      gapCount,
    };
  };

  const resolveLodBase = (entry: ChunkLodEntry): { time: Float64Array; value: Float64Array; length: number } | null => {
    const level = entry.lod.levels[0];
    if (level && level.length > 0) {
      return {
        time: level.time,
        value: level.value,
        length: level.length,
      };
    }
    if (entry.lodOnlyBase) {
      return entry.lodOnlyBase;
    }
    return null;
  };

  const cancelChunkLodRequest = (entry: ChunkLodEntry): void => {
    if (entry.pendingRequestId === null) return;
    chunkLodRequests.delete(entry.pendingRequestId);
    chunkLodRequestTimes.delete(entry.pendingRequestId);
    entry.pendingRequestId = null;
  };

  const cancelChunkLodBuild = (entry: ChunkLodEntry): void => {
    if (!entry.pendingBuildToken) return;
    entry.pendingBuildToken.canceled = true;
    entry.pendingBuildToken = null;
  };

  const releaseChunkLodEntry = (entry: ChunkLodEntry): void => {
    cancelChunkLodRequest(entry);
    cancelChunkLodBuild(entry);
    chunkedLodBytes -= entry.bytes;
    entry.lodOnlyBase = null;
    delete entry.lodStats;
  };

  const resetChunkLodEntry = (entry: ChunkLodEntry): boolean => {
    if (entry.bytes <= 0) return false;
    const previousBytes = entry.bytes;
    entry.lod.clear();
    entry.lodOnlyBase = null;
    delete entry.lodStats;
    entry.bytes = entry.lod.bytesUsed;
    chunkedLodBytes += entry.bytes - previousBytes;
    return true;
  };

  const detachProvider = (series: InternalSeries): void => {
    if (!series.provider) return;
    series.provider.unsubscribe?.();
    series.provider = undefined;
  };

  const clearChunkLods = (series: InternalSeries): void => {
    for (const entry of series.chunkLods.values()) {
      releaseChunkLodEntry(entry);
    }
    series.chunkLods.clear();
  };

  const pruneChunkLodsForRehydrate = (series: InternalSeries, range: VisibleTimeRange): void => {
    for (const [key, entry] of series.chunkLods.entries()) {
      const intersects = rangeIntersects(range, { from: entry.startTime, to: entry.endTime });
      if (!entry.lodOnly || intersects) {
        releaseChunkLodEntry(entry);
        series.chunkLods.delete(key);
      }
    }
  };

  const ensureStaticSeries = (series: InternalSeries): void => {
    if (!isChunkedStore(series.data)) return;
    detachProvider(series);
    series.data = new DataStore();
    series.dataMode = 'static';
    resetLodState(series);
    clearChunkLods(series);
    clearAxisBuckets(series);
  };

  const clearAxisBuckets = (series: InternalSeries): void => {
    series.axisBuckets = null;
    series.axisBucketSize = 0;
  };

  const clearOhlcAxisBuckets = (series: InternalSeries): void => {
    series.ohlcAxisBuckets = null;
    series.ohlcAxisBucketSize = 0;
  };

  const shouldUseAxisBuckets = (length: number): boolean =>
    length >= resolveAxisBucketSize(length) * AXIS_BUCKET_MIN_COUNT;

  const buildAxisBucketStats = (
    values: Float64Array,
    start: number,
    end: number,
  ): AxisBucketStats => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let minPositive = Number.POSITIVE_INFINITY;
    let hasData = false;
    const safeEnd = Math.max(start, Math.min(end, values.length));
    for (let i = start; i < safeEnd; i += 1) {
      const v = values[i]!;
      if (!Number.isFinite(v)) continue;
      hasData = true;
      if (v < min) min = v;
      if (v > max) max = v;
      if (v > 0 && v < minPositive) minPositive = v;
    }
    return { min, max, minPositive, hasData };
  };

  const buildAxisBuckets = (store: DataStore, bucketSize: number): AxisBucketStats[] => {
    const length = store.length;
    const bucketCount = Math.ceil(length / bucketSize);
    const buckets = new Array<AxisBucketStats>(bucketCount);
    const values = store.values();
    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
      const start = bucketIndex * bucketSize;
      const end = Math.min(length, start + bucketSize);
      buckets[bucketIndex] = buildAxisBucketStats(values, start, end);
    }
    return buckets;
  };

  const buildOhlcBucketStats = (
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    start: number,
    end: number,
  ): AxisBucketStats => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let minPositive = Number.POSITIVE_INFINITY;
    let hasData = false;
    const safeEnd = Math.max(start, Math.min(end, open.length));
    for (let i = start; i < safeEnd; i += 1) {
      const o = open[i]!;
      const h = high[i]!;
      const l = low[i]!;
      const c = close[i]!;
      if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
        continue;
      }
      hasData = true;
      if (l < min) min = l;
      if (h > max) max = h;
      if (o > 0 && o < minPositive) minPositive = o;
      if (h > 0 && h < minPositive) minPositive = h;
      if (l > 0 && l < minPositive) minPositive = l;
      if (c > 0 && c < minPositive) minPositive = c;
    }
    return { min, max, minPositive, hasData };
  };

  const buildOhlcBuckets = (store: OhlcDataStore, bucketSize: number): AxisBucketStats[] => {
    const length = store.length;
    const bucketCount = Math.ceil(length / bucketSize);
    const buckets = new Array<AxisBucketStats>(bucketCount);
    const open = store.opens();
    const high = store.highs();
    const low = store.lows();
    const close = store.closes();
    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
      const start = bucketIndex * bucketSize;
      const end = Math.min(length, start + bucketSize);
      buckets[bucketIndex] = buildOhlcBucketStats(open, high, low, close, start, end);
    }
    return buckets;
  };

  const ensureAxisBuckets = (series: InternalSeries): void => {
    if (isChunkedStore(series.data)) {
      clearAxisBuckets(series);
      return;
    }
    const store = series.data as DataStore;
    if (!shouldUseAxisBuckets(store.length)) {
      clearAxisBuckets(series);
      return;
    }
    const bucketSize = resolveAxisBucketSize(store.length);
    const expectedCount = Math.ceil(store.length / bucketSize);
    if (series.axisBucketSize !== bucketSize || !series.axisBuckets) {
      series.axisBucketSize = bucketSize;
      series.axisBuckets = buildAxisBuckets(store, bucketSize);
      return;
    }
    if (series.axisBuckets.length !== expectedCount) {
      series.axisBuckets = buildAxisBuckets(store, bucketSize);
    }
  };

  const ensureOhlcAxisBuckets = (series: InternalSeries): void => {
    const store = series.ohlcData;
    if (!store) {
      clearOhlcAxisBuckets(series);
      return;
    }
    if (!shouldUseAxisBuckets(store.length)) {
      clearOhlcAxisBuckets(series);
      return;
    }
    const bucketSize = resolveAxisBucketSize(store.length);
    const expectedCount = Math.ceil(store.length / bucketSize);
    if (series.ohlcAxisBucketSize !== bucketSize || !series.ohlcAxisBuckets) {
      series.ohlcAxisBucketSize = bucketSize;
      series.ohlcAxisBuckets = buildOhlcBuckets(store, bucketSize);
      return;
    }
    if (series.ohlcAxisBuckets.length !== expectedCount) {
      series.ohlcAxisBuckets = buildOhlcBuckets(store, bucketSize);
    }
  };

  const updateAxisBucketsForRange = (series: InternalSeries, startIndex: number, endIndex: number): void => {
    if (isChunkedStore(series.data)) return;
    const buckets = series.axisBuckets;
    if (!buckets || series.axisBucketSize <= 0) return;
    const store = series.data as DataStore;
    const length = store.length;
    if (length <= 0) return;
    const bucketSize = series.axisBucketSize;
    const expectedCount = Math.ceil(length / bucketSize);
    if (buckets.length !== expectedCount) {
      series.axisBuckets = buildAxisBuckets(store, bucketSize);
      return;
    }
    const values = store.values();
    const from = Math.max(0, Math.min(startIndex, length - 1));
    const to = Math.max(0, Math.min(endIndex, length - 1));
    const startBucket = Math.floor(from / bucketSize);
    const endBucket = Math.floor(to / bucketSize);
    for (let bucketIndex = startBucket; bucketIndex <= endBucket; bucketIndex += 1) {
      const start = bucketIndex * bucketSize;
      const end = Math.min(length, start + bucketSize);
      buckets[bucketIndex] = buildAxisBucketStats(values, start, end);
    }
  };

  const updateOhlcAxisBucketsForRange = (
    series: InternalSeries,
    startIndex: number,
    endIndex: number,
  ): void => {
    const store = series.ohlcData;
    const buckets = series.ohlcAxisBuckets;
    if (!store || !buckets || series.ohlcAxisBucketSize <= 0) return;
    const length = store.length;
    if (length <= 0) return;
    const bucketSize = series.ohlcAxisBucketSize;
    const expectedCount = Math.ceil(length / bucketSize);
    if (buckets.length !== expectedCount) {
      series.ohlcAxisBuckets = buildOhlcBuckets(store, bucketSize);
      return;
    }
    const open = store.opens();
    const high = store.highs();
    const low = store.lows();
    const close = store.closes();
    const from = Math.max(0, Math.min(startIndex, length - 1));
    const to = Math.max(0, Math.min(endIndex, length - 1));
    const startBucket = Math.floor(from / bucketSize);
    const endBucket = Math.floor(to / bucketSize);
    for (let bucketIndex = startBucket; bucketIndex <= endBucket; bucketIndex += 1) {
      const start = bucketIndex * bucketSize;
      const end = Math.min(length, start + bucketSize);
      buckets[bucketIndex] = buildOhlcBucketStats(open, high, low, close, start, end);
    }
  };

  const dropOldestNonReset = (queue: DataProviderUpdate[]): void => {
    const idx = queue.findIndex((item) => item.type !== 'reset');
    if (idx >= 0) {
      queue.splice(idx, 1);
    } else {
      queue.shift();
    }
  };

  const mergeProviderUpdate = (queue: DataProviderUpdate[], update: DataProviderUpdate): boolean => {
    if (queue.length === 0) return false;
    const last = queue[queue.length - 1]!;
    if (update.type === 'append') {
      if (last.type === 'append') {
        queue[queue.length - 1] = { type: 'appendBatch', points: [last.point, update.point] };
        return true;
      }
      if (last.type === 'appendBatch') {
        last.points.push(update.point);
        return true;
      }
      return false;
    }
    if (update.type === 'appendBatch') {
      if (last.type === 'append') {
        queue[queue.length - 1] = { type: 'appendBatch', points: [last.point, ...update.points] };
        return true;
      }
      if (last.type === 'appendBatch') {
        last.points.push(...update.points);
        return true;
      }
      return false;
    }
    if (update.type === 'updateLast') {
      if (last.type === 'updateLast') {
        last.point = update.point;
        return true;
      }
      if (last.type === 'append') {
        if (last.point.t === update.point.t) {
          last.point = update.point;
          return true;
        }
      }
      if (last.type === 'appendBatch') {
        const lastIndex = last.points.length - 1;
        if (lastIndex >= 0 && last.points[lastIndex]!.t === update.point.t) {
          last.points[lastIndex] = update.point;
          return true;
        }
      }
      return false;
    }
    return false;
  };

  const refreshLoadedRange = (series: InternalSeries): void => {
    if (!series.provider || !isChunkedStore(series.data)) {
      return;
    }
    const store = series.data;
    if (store.chunkCount === 0) {
      series.provider.loadedRange = null;
      return;
    }
    const first = store.getChunk(0);
    const last = store.getChunk(store.chunkCount - 1);
    if (!first || !last || !Number.isFinite(first.startTime) || !Number.isFinite(last.endTime)) {
      series.provider.loadedRange = null;
      return;
    }
    series.provider.loadedRange = normalizeRange({ from: first.startTime, to: last.endTime });
  };

  const pruneChunkLods = (
    series: InternalSeries,
    chunks: Array<{ startTime: number }>,
    keepLodOnly = false,
  ): boolean => {
    if (series.chunkLods.size === 0) return false;
    const active = new Set<number>();
    for (const chunk of chunks) {
      active.add(chunk.startTime);
    }
    let removed = false;
    for (const [key, entry] of series.chunkLods.entries()) {
      if (!active.has(key)) {
        if (keepLodOnly && entry.lodOnly) continue;
        releaseChunkLodEntry(entry);
        series.chunkLods.delete(key);
        removed = true;
      }
    }
    return removed;
  };

  const findChunkByStartTime = (store: ChunkedDataStore, startTime: number) => {
    const chunks = store.getChunks();
    for (const chunk of chunks) {
      if (chunk.startTime === startTime) return chunk;
    }
    return null;
  };

  const ensureChunkLod = (
    series: InternalSeries,
    chunk: { startTime: number; endTime: number; length: number; time: Float64Array; value: Float64Array },
    frameId: number,
  ): { lod?: LodPyramid; changed: boolean } => {
    const lastValue = resolveChunkLastValue(chunk);
    let entry = series.chunkLods.get(chunk.startTime) ?? null;
    if (entry?.lodOnly) {
      releaseChunkLodEntry(entry);
      entry.lod = new LodPyramid(lodOptions);
      entry.lodOnly = false;
      entry.lodOnlyBase = null;
      delete entry.lodStats;
      entry.bytes = entry.lod.bytesUsed;
    }
    if (!entry) {
      const lod = new LodPyramid(lodOptions);
      const created: ChunkLodEntry = {
        lod,
        startTime: chunk.startTime,
        length: chunk.length,
        endTime: chunk.endTime,
        lastValue,
        bytes: lod.bytesUsed,
        lastTouched: frameId,
        pendingRequestId: null,
        pendingBuildToken: null,
        lodOnly: false,
        lodOnlyBase: null,
      };
      series.chunkLods.set(chunk.startTime, created);
      if (chunk.length >= LOD_CHUNK_POINTS) {
        const worker = getLodWorker();
        if (worker) {
          requestChunkLodBuild(series, chunk, created, worker);
          return { lod, changed: false };
        }
        const changed = resetChunkLodEntry(created);
        startChunkLodBuild(series, chunk, created);
        return { lod, changed };
      }
      withLodWork(() => lod.rebuild(chunk.time, chunk.value, chunk.length));
      created.bytes = lod.bytesUsed;
      chunkedLodBytes += created.bytes;
      return { lod, changed: true };
    }

    entry.lastTouched = frameId;
    if (
      entry.length === chunk.length &&
      entry.endTime === chunk.endTime &&
      Object.is(entry.lastValue, lastValue)
    ) {
      return { lod: entry.lod, changed: false };
    }

    cancelChunkLodRequest(entry);
    cancelChunkLodBuild(entry);
    const previousLength = entry.length;
    entry.length = chunk.length;
    entry.endTime = chunk.endTime;
    entry.lastValue = lastValue;

    if (chunk.length >= LOD_CHUNK_POINTS) {
      const worker = getLodWorker();
      if (worker) {
        const changed = resetChunkLodEntry(entry);
        requestChunkLodBuild(series, chunk, entry, worker);
        return { lod: entry.lod, changed };
      }
      const changed = resetChunkLodEntry(entry);
      startChunkLodBuild(series, chunk, entry);
      return { lod: entry.lod, changed };
    }

    const previousBytes = entry.bytes;
    if (chunk.length < previousLength) {
      withLodWork(() => entry.lod.rebuild(chunk.time, chunk.value, chunk.length));
    } else if (chunk.length > previousLength) {
      withLodWork(() =>
        entry.lod.appendBatch(chunk.time, chunk.value, previousLength, chunk.length),
      );
    } else {
      withLodWork(() => entry.lod.updateLast(chunk.time, chunk.value, chunk.length));
    }
    entry.bytes = entry.lod.bytesUsed;
    chunkedLodBytes += entry.bytes - previousBytes;
    return { lod: entry.lod, changed: true };
  };

  const storeLodOnlyChunk = (
    series: InternalSeries,
    chunk: { startTime: number; endTime: number; length: number; time: Float64Array; value: Float64Array },
  ): void => {
    if (!retainLodOnly) return;
    const safeLength = Math.min(chunk.length, chunk.time.length, chunk.value.length);
    if (safeLength <= 0) return;

    let entry = series.chunkLods.get(chunk.startTime);
    if (entry) {
      releaseChunkLodEntry(entry);
    }

    const lod = new LodPyramid(lodRetentionOptions);
    withLodWork(() => lod.rebuild(chunk.time, chunk.value, safeLength));

    let lodOnlyBase: { time: Float64Array; value: Float64Array; length: number } | null = null;
    if (lod.levels.length === 0) {
      const timeCopy = new Float64Array(safeLength);
      const valueCopy = new Float64Array(safeLength);
      timeCopy.set(chunk.time.subarray(0, safeLength));
      valueCopy.set(chunk.value.subarray(0, safeLength));
      lodOnlyBase = { time: timeCopy, value: valueCopy, length: safeLength };
    }

    const base = lod.levels[0]
      ? { time: lod.levels[0].time, value: lod.levels[0].value, length: lod.levels[0].length }
      : lodOnlyBase;
    const stats = buildChunkStats(chunk.value, safeLength);

    entry = {
      lod,
      startTime: chunk.startTime,
      length: safeLength,
      endTime: chunk.endTime,
      lastValue: resolveChunkLastValue(chunk),
      bytes: 0,
      lastTouched: chunkedLodFrame,
      pendingRequestId: null,
      pendingBuildToken: null,
      lodOnly: true,
      lodOnlyBase,
      lodStats: stats,
    };
    const baseBytes = lodOnlyBase ? lodOnlyBase.time.byteLength + lodOnlyBase.value.byteLength : 0;
    entry.bytes = lod.bytesUsed + baseBytes;
    chunkedLodBytes += entry.bytes;
    series.chunkLods.set(chunk.startTime, entry);
  };

  const collectLodOnlyChunks = (
    series: InternalSeries,
    range: VisibleTimeRange,
    activeStarts: Set<number>,
    frameId: number | null,
  ): Array<{
    startTime: number;
    endTime: number;
    time: Float64Array;
    value: Float64Array;
    length: number;
    stats: ChunkStats;
    lod: LodPyramid;
  }> => {
    if (!retainLodOnly || series.chunkLods.size === 0) return [];
    const chunks: Array<{
      startTime: number;
      endTime: number;
      time: Float64Array;
      value: Float64Array;
      length: number;
      stats: ChunkStats;
      lod: LodPyramid;
    }> = [];
    for (const [startTime, entry] of series.chunkLods.entries()) {
      if (!entry.lodOnly) continue;
      if (activeStarts.has(startTime)) continue;
      if (entry.endTime < range.from || entry.startTime > range.to) continue;
      const base = resolveLodBase(entry);
      if (!base || base.length <= 0) continue;
      const stats = entry.lodStats ?? buildChunkStats(base.value, base.length);
      chunks.push({
        startTime: entry.startTime,
        endTime: entry.endTime,
        time: base.time,
        value: base.value,
        length: base.length,
        stats,
        lod: entry.lod,
      });
      if (frameId !== null) {
        entry.lastTouched = frameId;
      }
    }
    return chunks;
  };

  const evictChunkLodsIfNeeded = (): boolean => {
    if (!Number.isFinite(chunkedLodBudget) || chunkedLodBudget <= 0) return false;
    if (chunkedLodBytes <= chunkedLodBudget) return false;

    const entries: Array<{ series: InternalSeries; key: number; entry: ChunkLodEntry }> = [];
    for (const series of seriesList) {
      for (const [key, entry] of series.chunkLods.entries()) {
        entries.push({ series, key, entry });
      }
    }
    entries.sort((a, b) => a.entry.lastTouched - b.entry.lastTouched);

    let evicted = false;
    for (const item of entries) {
      if (chunkedLodBytes <= chunkedLodBudget) break;
      releaseChunkLodEntry(item.entry);
      item.series.chunkLods.delete(item.key);
      evicted = true;
    }
    return evicted;
  };

  const resolveEvictionPadding = (state: SeriesProviderState, range: VisibleTimeRange): number => {
    const span = range.to - range.from;
    if (!Number.isFinite(span) || span <= 0) return 0;
    const requested =
      typeof state.options.prefetchMs === 'number' && Number.isFinite(state.options.prefetchMs)
        ? state.options.prefetchMs
        : 0;
    const maxPadding = span * 0.5;
    return Math.max(0, Math.min(requested, maxPadding));
  };

  const enforceMemoryPolicy = (range: VisibleTimeRange): void => {
    let totalBytes = 0;

    const evict = (paddingOverride?: number): void => {
      totalBytes = 0;
      for (const series of seriesList) {
        if (!series.provider || !isChunkedStore(series.data)) continue;
        const store = series.data;
        const padding =
          typeof paddingOverride === 'number'
            ? paddingOverride
            : resolveEvictionPadding(series.provider, range);
        const removed = store.evictOutsideRange(range, padding);
        if (removed > 0) {
          refreshLoadedRange(series);
          pruneChunkLods(series, store.getChunks(), retainLodOnly);
          bumpSeriesRevision(series);
        }
        totalBytes += store.bytesUsed;
      }
    };

    evict(rawRetentionMs ?? undefined);

    const budget =
      typeof memoryBudgets.dataBytes === 'number' && Number.isFinite(memoryBudgets.dataBytes)
        ? memoryBudgets.dataBytes
        : null;
    if (budget && totalBytes > budget) {
      evict(0);
      if (totalBytes > budget) {
        for (const series of seriesList) {
          if (series.lodBuildToken) {
            series.lodBuildToken.canceled = true;
            series.lodBuildToken = null;
          }
          series.lod.clear();
          clearChunkLods(series);
        }
        decimator.clearCache();
        chunkedDecimator.clearCache();
        bumpSeriesRevision();
      }
    }
  };

  const scheduleProviderFrame = (cb: (time: number) => void): number => {
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(cb);
    }
    if (typeof setTimeout === 'function') {
      return setTimeout(() => cb(nowTime()), 16) as unknown as number;
    }
    cb(nowTime());
    return 0;
  };

  const scheduleProviderFlush = (series: InternalSeries): void => {
    const state = series.provider;
    if (!state || state.scheduled) return;
    state.scheduled = true;
    scheduleProviderFrame(() => {
      const current = series.provider;
      if (!current) {
        state.scheduled = false;
        return;
      }
      if (current.queue.length === 0) {
        state.scheduled = false;
        return;
      }
      const updates = current.queue.splice(0);
      let changed = false;
      for (const update of updates) {
        if (!isChunkedStore(series.data)) {
          changed = true;
          continue;
        }
        const store = series.data;
        const prevVersion = store.version;
        if (update.type === 'append') {
          store.append(update.point);
        } else if (update.type === 'appendBatch') {
          store.appendBatch(update.points);
        } else if (update.type === 'updateLast') {
          store.updateLast(update.point);
        } else if (update.type === 'reset') {
          store.clear();
          clearChunkLods(series);
          store.appendChunk(update.chunk);
          current.loadedRange = deriveRangeFromChunk(update.chunk) ?? normalizeRange(update.range);
        }
        const didChange = store.version !== prevVersion;
        if (didChange) {
          if (update.type === 'append' || update.type === 'updateLast') {
            extendSeriesTimeStepFromPoints(series, [update.point]);
          } else if (update.type === 'appendBatch') {
            extendSeriesTimeStepFromPoints(series, update.points);
          } else if (update.type === 'reset') {
            resetSeriesTimeStep(series, update.chunk.time, update.chunk.length);
          }
          if (update.type === 'append' || update.type === 'updateLast') {
            if (current.loadedRange) {
              current.loadedRange.to = Math.max(current.loadedRange.to, update.point.t);
              current.loadedRange.from = Math.min(current.loadedRange.from, update.point.t);
            } else {
              current.loadedRange = { from: update.point.t, to: update.point.t + 1 };
            }
          } else if (update.type === 'appendBatch') {
            const points = update.points;
            if (points.length > 0) {
              let minTime = points[0]!.t;
              let maxTime = points[0]!.t;
              for (const point of points) {
                minTime = Math.min(minTime, point.t);
                maxTime = Math.max(maxTime, point.t);
              }
              if (current.loadedRange) {
                current.loadedRange.to = Math.max(current.loadedRange.to, maxTime);
                current.loadedRange.from = Math.min(current.loadedRange.from, minTime);
              } else {
                current.loadedRange = { from: minTime, to: maxTime + 1 };
              }
            }
          }
          changed = true;
        }
      }

      if (changed) {
        bumpSeriesRevision(series);
        syncTimeScaleToData();
        enforceMemoryPolicy(xScale.getVisibleRange());
        invalidate(InvalidationFlag.All);
      }

      state.scheduled = false;
      if (current.queue.length > 0) {
        scheduleProviderFlush(series);
      }
    });
  };

  const enqueueProviderUpdate = (series: InternalSeries, update: DataProviderUpdate): void => {
    const state = series.provider;
    if (!state) return;
    if (update.type === 'reset') {
      state.queue.length = 0;
      state.queue.push(update);
      scheduleProviderFlush(series);
      return;
    }

    const maxPending = state.options.maxPendingUpdates;
    const backpressure = state.options.backpressure ?? 'drop';
    let merged = false;
    if (backpressure === 'coalesce') {
      merged = mergeProviderUpdate(state.queue, update);
    }

    if (!merged && typeof maxPending === 'number' && maxPending > 0 && state.queue.length >= maxPending) {
      if (backpressure === 'drop') {
        return;
      }
      if (backpressure === 'coalesce') {
        dropOldestNonReset(state.queue);
      }
    }

    if (!merged && backpressure === 'coalesce') {
      merged = mergeProviderUpdate(state.queue, update);
    }

    if (!merged) {
      state.queue.push(update);
    }
    scheduleProviderFlush(series);
  };

  const requestProviderRange = (series: InternalSeries, range: VisibleTimeRange): void => {
    const state = series.provider;
    if (!state) return;
    const baseRange = clampRangeToExtents(range, state.extents);
    const expanded = expandRange(baseRange, state.options.prefetchMs);
    if (state.loadedRange && rangeContains(state.loadedRange, expanded)) return;
    if (state.pendingRange && rangeContains(state.pendingRange, expanded)) return;
    const requestId = (state.requestId += 1);
    state.pendingRange = expanded;
    state.provider
      .getRange(expanded)
      .then((chunk) => {
        const current = series.provider;
        if (!current || current.requestId !== requestId) return;
        current.pendingRange = null;
        if (!isChunkedStore(series.data)) return;
        const loadedRange = deriveRangeFromChunk(chunk) ?? expanded;
        series.data.clear();
        series.data.appendChunk(chunk);
        if (retainLodOnly) {
          pruneChunkLodsForRehydrate(series, loadedRange);
        } else {
          clearChunkLods(series);
        }
        resetSeriesTimeStep(series, chunk.time, chunk.length);
        current.loadedRange = loadedRange;
        bumpSeriesRevision(series);
        decimator.clearCache();
        chunkedDecimator.clearCache();
        syncTimeScaleToData();
        invalidate(InvalidationFlag.All);
      })
      .catch(() => {
        const current = series.provider;
        if (current && current.requestId === requestId) {
          current.pendingRange = null;
        }
      });
  };

  const smoothAxisValue = (current: number, target: number, alpha: number): number =>
    current + (target - current) * alpha;

  const smoothAxisRange = (
    current: Pick<AxisScaleRange, 'min' | 'max' | 'minPositive'>,
    target: AxisScaleRange,
  ): AxisScaleRange => {
    if (!target.hasData) return target;
    const minAlpha = target.min < current.min ? AXIS_DAMP_EXPAND : AXIS_DAMP_SHRINK;
    const maxAlpha = target.max > current.max ? AXIS_DAMP_EXPAND : AXIS_DAMP_SHRINK;
    let min = smoothAxisValue(current.min, target.min, minAlpha);
    let max = smoothAxisValue(current.max, target.max, maxAlpha);
    if (max <= min) {
      const mid = (max + min) * 0.5;
      const pad = Math.max(1e-9, Math.abs(mid) * 0.02);
      min = mid - pad;
      max = mid + pad;
    }
    let minPositive = target.minPositive;
    if (Number.isFinite(current.minPositive) && current.minPositive > 0 && Number.isFinite(target.minPositive)) {
      const posAlpha = target.minPositive < current.minPositive ? AXIS_DAMP_EXPAND : AXIS_DAMP_SHRINK;
      minPositive = smoothAxisValue(current.minPositive, target.minPositive, posAlpha);
    }
    return { min, max, minPositive, hasData: true };
  };

  const findFirstVisibleInChunks = (
    chunks: AxisScaleChunk[],
    range: VisibleTimeRange,
  ): { time: number; value: number } | null => {
    for (const chunk of chunks) {
      if (chunk.endTime < range.from) continue;
      if (chunk.startTime > range.to) break;
      const from = lowerBound(chunk.time, chunk.length, range.from);
      const to = upperBound(chunk.time, chunk.length, range.to);
      for (let i = from; i < to; i += 1) {
        const v = chunk.value[i]!;
        if (!Number.isFinite(v)) continue;
        const t = chunk.time[i]!;
        if (Number.isFinite(t)) return { time: t, value: v };
      }
    }
    return null;
  };

  const resolveFirstVisibleValue = (
    source: AxisScaleSource,
    range: VisibleTimeRange,
  ): { time: number; value: number } | null => {
    if (!isChunkedStore(source.data)) {
      const values = source.data.values();
      const times = source.data.times();
      const from = source.data.lowerBound(range.from);
      const to = source.data.upperBound(range.to);
      for (let i = from; i < to; i += 1) {
        const v = values[i]!;
        if (!Number.isFinite(v)) continue;
        const t = times[i]!;
        if (Number.isFinite(t)) return { time: t, value: v };
      }
      return null;
    }
    const rawChunks = source.data.getChunks() as AxisScaleChunk[];
    const rawHit = findFirstVisibleInChunks(rawChunks, range);
    if (rawHit) return rawHit;
    if (source.lodChunks && source.lodChunks.length > 0) {
      return findFirstVisibleInChunks(source.lodChunks, range);
    }
    return null;
  };

  const resolveAxisBaseValue = (
    sources: AxisScaleSource[],
    range: VisibleTimeRange,
    axis: AxisId,
  ): number | null => {
    let baseTime = Number.POSITIVE_INFINITY;
    let baseValue: number | null = null;
    for (const source of sources) {
      if (!source.visible || source.axis !== axis) continue;
      const result = resolveFirstVisibleValue(source, range);
      if (!result) continue;
      if (result.time < baseTime) {
        baseTime = result.time;
        baseValue = result.value;
      }
    }
    return Number.isFinite(baseValue) ? baseValue : null;
  };

  const updateAxisScales = (
    pane: InternalPane,
    range: VisibleTimeRange,
  ): { left: AxisScaleRange; right: AxisScaleRange } => {
    // V7: Always freeze Y-axis during horizontal drag (frozenAxisRanges is set by captureAxisFreezeForHorizontalDrag)
    // Also respect user preference (panFreezeAxis option)
    const frozenRanges = panActive && frozenAxisRanges ? frozenAxisRanges : null;
    const shouldFreeze = frozenRanges !== null;
    const leftManual = axisManualRanges.get(getAxisOverrideKey(pane.id, 'left'));
    const rightManual = axisManualRanges.get(getAxisOverrideKey(pane.id, 'right'));
    if (shouldFreeze && panFreezeAxisThreshold === null) {
      const frozen = frozenRanges.get(pane.id);
      if (frozen && !leftManual && !rightManual) {
        pane.leftScale.setRange(frozen.left.min, frozen.left.max, frozen.left.minPositive);
        pane.rightScale.setRange(frozen.right.min, frozen.right.max, frozen.right.minPositive);
        return {
          left: { ...frozen.left, hasData: true },
          right: { ...frozen.right, hasData: true },
        };
      }
    }

    const paneSeries = getPaneSeries(pane.id);
    const volumeSeries = paneSeries.filter((s) => s.visible && s.options.isVolume);
    const standardSeries = paneSeries.filter((s) => !s.options.isVolume);

    const axisSources: AxisScaleSource[] = standardSeries.map((series) => {
      if (!isChunkedStore(series.data)) {
        const bucketSize =
          Number.isFinite(series.axisBucketSize) && series.axisBucketSize > 0
            ? series.axisBucketSize
            : null;
        const buckets = series.axisBuckets ?? null;
        const ohlcStore = series.ohlcData ?? null;
        const ohlcBucketSize =
          Number.isFinite(series.ohlcAxisBucketSize) && series.ohlcAxisBucketSize > 0
            ? series.ohlcAxisBucketSize
            : null;
        const ohlcBuckets = series.ohlcAxisBuckets ?? null;
        const ohlc = ohlcStore
          ? {
            data: ohlcStore,
            ...(ohlcBucketSize ? { bucketSize: ohlcBucketSize } : {}),
            ...(ohlcBucketSize && ohlcBuckets ? { buckets: ohlcBuckets } : {}),
          }
          : undefined;
        return {
          axis: series.axis,
          visible: series.visible,
          data: series.data,
          ...(bucketSize ? { bucketSize } : {}),
          ...(bucketSize && buckets ? { buckets } : {}),
          ...(ohlc ? { ohlc } : {}),
        };
      }
      if (!series.visible || !retainLodOnly) {
        return { axis: series.axis, visible: series.visible, data: series.data };
      }
      const rawChunks = series.data.getChunks();
      const activeStarts = new Set<number>();
      for (const chunk of rawChunks) {
        activeStarts.add(chunk.startTime);
      }
      const lodChunks = collectLodOnlyChunks(series, range, activeStarts, null);
      if (lodChunks.length > 1) {
        lodChunks.sort((a, b) => a.startTime - b.startTime);
      }
      return lodChunks.length > 0
        ? { axis: series.axis, visible: series.visible, data: series.data, lodChunks }
        : { axis: series.axis, visible: series.visible, data: series.data };
    });

    const leftMode = pane.leftScale.getMode();
    const rightMode = pane.rightScale.getMode();
    const leftBase = leftMode === 'normal' ? null : resolveAxisBaseValue(axisSources, range, 'left');
    const rightBase = rightMode === 'normal' ? null : resolveAxisBaseValue(axisSources, range, 'right');

    setAxisScaleBase(pane.id, 'left', leftBase);
    setAxisScaleBase(pane.id, 'right', rightBase);

    for (const series of paneSeries) {
      series.scaleBase = series.axis === 'right' ? rightBase : leftBase;
    }

    for (const source of axisSources) {
      if (source.axis === 'left') {
        source.baseValue = leftBase;
      } else {
        source.baseValue = rightBase;
      }
    }

    let leftRange = computeAxisRange(axisSources, range, 'left', leftMode);
    let rightRange = computeAxisRange(axisSources, range, 'right', rightMode);

    // Smart Volume Scaling: Calculate max volume in visible range for this pane
    let maxVolume = 0;
    if (volumeSeries.length > 0) {
      const volumeSources: AxisScaleSource[] = volumeSeries.map((series) => ({
        axis: series.axis,
        visible: series.visible,
        data: series.data,
      }));
      // We use 'left' as a dummy axis since we just want the max across all volume series in this pane
      const volRangeLeft = computeAxisRange(volumeSources, range, 'left', 'normal');
      const volRangeRight = computeAxisRange(volumeSources, range, 'right', 'normal');
      maxVolume = Math.max(
        volRangeLeft.hasData ? volRangeLeft.max : 0,
        volRangeRight.hasData ? volRangeRight.max : 0,
      );
    }
    pane.maxVolume = maxVolume;

    const leftOptions = pane.leftScale.getOptions();
    const rightOptions = pane.rightScale.getOptions();
    leftRange = applyAxisMargins(leftRange, leftOptions.scaleMargins, leftOptions.type ?? 'linear');
    rightRange = applyAxisMargins(rightRange, rightOptions.scaleMargins, rightOptions.type ?? 'linear');
    leftRange = applyAxisPadding(leftRange, leftOptions.autoScalePadding, leftOptions.type ?? 'linear');
    rightRange = applyAxisPadding(rightRange, rightOptions.autoScalePadding, rightOptions.type ?? 'linear');

    if (shouldFreeze && panFreezeAxisThreshold !== null && !leftManual && !rightManual) {
      const frozen = frozenRanges.get(pane.id);
      if (frozen) {
        const shouldUpdate = (
          current: Pick<AxisScaleRange, 'min' | 'max' | 'minPositive'>,
          next: AxisScaleRange,
        ): boolean => {
          if (!next.hasData) return false;
          const span = Math.max(1e-9, current.max - current.min);
          const slack = span * panFreezeAxisThreshold;
          return next.min < current.min - slack || next.max > current.max + slack;
        };
        if (shouldUpdate(frozen.left, leftRange)) {
          frozen.left = { min: leftRange.min, max: leftRange.max, minPositive: leftRange.minPositive };
        }
        if (shouldUpdate(frozen.right, rightRange)) {
          frozen.right = { min: rightRange.min, max: rightRange.max, minPositive: rightRange.minPositive };
        }
        pane.leftScale.setRange(frozen.left.min, frozen.left.max, frozen.left.minPositive);
        pane.rightScale.setRange(frozen.right.min, frozen.right.max, frozen.right.minPositive);
        return {
          left: { ...frozen.left, hasData: true },
          right: { ...frozen.right, hasData: true },
        };
      }
    }

    if (leftManual) {
      leftRange = { ...leftManual, hasData: true };
    }
    if (rightManual) {
      rightRange = { ...rightManual, hasData: true };
    }

    const dampingActive =
      !panFreezeAxis &&
      (panAxisSmoothing === 'always'
        ? panActive || inertiaActive
        : panAxisSmoothing === 'inertia'
          ? inertiaActive
          : false);
    if (dampingActive) {
      const current = axisSmoothing.get(pane.id);
      if (current) {
        if (!leftManual) {
          leftRange = smoothAxisRange(current.left, leftRange);
        }
        if (!rightManual) {
          rightRange = smoothAxisRange(current.right, rightRange);
        }
      }
    }

    axisSmoothing.set(pane.id, {
      left: { min: leftRange.min, max: leftRange.max, minPositive: leftRange.minPositive },
      right: { min: rightRange.min, max: rightRange.max, minPositive: rightRange.minPositive },
    });

    pane.leftScale.setRange(leftRange.min, leftRange.max, leftRange.minPositive);
    pane.rightScale.setRange(rightRange.min, rightRange.max, rightRange.minPositive);
    return { left: leftRange, right: rightRange };
  };

  const isInsidePlot = (x: number, y: number): boolean => {
    if (!layoutState) return false;
    const rect = layoutState.plotRect;
    return (
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height
    );
  };

  const getPaneState = (paneId: PaneId): PaneState | null =>
    paneStateById.get(paneId) ?? null;

  const getDefaultPaneState = (): PaneState | null =>
    getPaneState(defaultPaneId) ?? paneStates[0] ?? null;

  const getPaneAtY = (y: number): PaneState | null => {
    for (const paneState of paneStates) {
      const rect = paneState.plotRect;
      if (y >= rect.y && y <= rect.y + rect.height) {
        return paneState;
      }
    }
    return null;
  };

  const getPaneDividerIndex = (x: number, y: number): number | null => {
    if (!paneResizeEnabled || paneStates.length < 2 || !layoutState) return null;
    const rect = layoutState.plotRect;
    if (x < rect.x || x > rect.x + rect.width) return null;
    const half = paneResizeHandlePx * 0.5;
    for (let i = 0; i < paneStates.length - 1; i += 1) {
      const paneRect = paneStates[i]!.plotRect;
      const dividerY = paneRect.y + paneRect.height;
      if (Math.abs(y - dividerY) <= half) {
        return i;
      }
    }
    return null;
  };

  const isPointInsideRect = (rect: Rect, x: number, y: number): boolean =>
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;

  const getAxisDragTarget = (
    x: number,
    y: number,
  ): { paneId: PaneId; axis: AxisId | 'time'; plotRect: Rect } | null => {
    if (!layoutState) return null;

    // Check time axis (X-axis)
    if (layoutState.timeAxisRect && isPointInsideRect(layoutState.timeAxisRect, x, y)) {
      return { paneId: defaultPaneId, axis: 'time', plotRect: layoutState.plotRect };
    }

    // Check Y-axes (price axes)
    const paneState = getPaneAtY(y);
    if (!paneState) return null;
    if (paneState.axisUsage.left && paneState.leftAxisRect) {
      if (isPointInsideRect(paneState.leftAxisRect, x, y)) {
        return { paneId: paneState.id, axis: 'left', plotRect: paneState.plotRect };
      }
    }
    if (paneState.axisUsage.right && paneState.rightAxisRect) {
      if (isPointInsideRect(paneState.rightAxisRect, x, y)) {
        return { paneId: paneState.id, axis: 'right', plotRect: paneState.plotRect };
      }
    }
    return null;
  };

  const clampRatio = (value: number): number => Math.min(1, Math.max(0, value));

  const applyExternalCrosshair = (state: CrosshairState, shouldInvalidate = true): void => {
    externalCrosshair = state;
    crosshairTime = Number.isFinite(state.time) ? state.time : null;
    if (!layoutState || !Number.isFinite(state.time)) {
      pendingExternalCrosshair = state;
      return;
    }
    const paneState = getPaneState(state.paneId ?? defaultPaneId) ?? getDefaultPaneState();
    if (!paneState) {
      pendingExternalCrosshair = state;
      return;
    }
    const yRatioInput = state.yRatio;
    const yRatio = typeof yRatioInput === 'number' && Number.isFinite(yRatioInput) ? clampRatio(yRatioInput) : 0.5;
    const plotRect = layoutState.plotRect;
    const x = plotRect.x + xScale.timeToX(state.time);
    const y = paneState.plotRect.y + paneState.plotRect.height * yRatio;
    crosshairActive = true;
    crosshairPaneId = paneState.id;
    crosshairX = x;
    crosshairY = y;
    crosshairTime = state.time;
    pendingExternalCrosshair = null;
    if (shouldInvalidate) {
      invalidate(InvalidationFlag.Overlay);
    }
  };

  const buildPluginState = (surface: CanvasSurface): PluginRenderState | null => {
    if (!layoutState) return null;
    const paneState = getDefaultPaneState();
    if (!paneState) return null;
    const plotRect = paneState.plotRect;
    const leftScale = getAxisScale(paneState.id, 'left');
    const rightScale = getAxisScale(paneState.id, 'right');
    const primaryScale = paneState.primaryAxis === 'right' ? rightScale : leftScale;
    const leftBase = getAxisScaleBase(paneState.id, 'left');
    const rightBase = getAxisScaleBase(paneState.id, 'right');
    const primaryBase = paneState.primaryAxis === 'right' ? rightBase : leftBase;

    // CONTINUOUS UPDATES: Sync manual axis ranges to scales during drag
    // This ensures drawing objects update in real-time during axis drag
    const leftManual = axisManualRanges.get(getAxisOverrideKey(paneState.id, 'left'));
    const rightManual = axisManualRanges.get(getAxisOverrideKey(paneState.id, 'right'));
    if (leftManual) {
      leftScale.setRange(leftManual.min, leftManual.max, leftManual.minPositive);
    }
    if (rightManual) {
      rightScale.setRange(rightManual.min, rightManual.max, rightManual.minPositive);
    }

    const panOffset = panOverscrollPx;
    return {
      layout: layoutState,
      plotRect,
      visibleRange: xScale.getVisibleRange(),
      panOffset,
      theme,
      timeToX: (time: number) => plotRect.x + xScale.timeToX(time) + panOffset,
      xToTime: (x: number) => xScale.xToTime(x - plotRect.x - panOffset) as TimeMs,
      valueToY: (value: number) => {
        // Determine which scale has actual data (same logic as yToValue)
        const rightRange = rightScale.getRange();
        const leftRange = leftScale.getRange();
        const rightHasData = (rightRange.max - rightRange.min) > 1;
        const leftHasData = (leftRange.max - leftRange.min) > 1;

        if (rightHasData) {
          return plotRect.y + rightScale.valueToY(rightScale.toScaleValue(value, rightBase));
        } else if (leftHasData) {
          return plotRect.y + leftScale.valueToY(leftScale.toScaleValue(value, leftBase));
        }
        return plotRect.y + primaryScale.valueToY(primaryScale.toScaleValue(value, primaryBase));
      },
      valueToYLeft: (value: number) =>
        plotRect.y + leftScale.valueToY(leftScale.toScaleValue(value, leftBase)),
      valueToYRight: (value: number) =>
        plotRect.y + rightScale.valueToY(rightScale.toScaleValue(value, rightBase)),
      yToValue: (y: number) => {
        // Convert absolute Y to relative Y within plot
        const relY = y - plotRect.y;

        // Determine which scale has actual data
        // Check if right scale has valid data (range > 1 means actual data, not default 0-1)
        const rightRange = rightScale.getRange();
        const leftRange = leftScale.getRange();
        const rightHasData = (rightRange.max - rightRange.min) > 1;
        const leftHasData = (leftRange.max - leftRange.min) > 1;

        // Use the scale with actual data, preferring right (common for financial charts)
        const dataScale = rightHasData ? rightScale : (leftHasData ? leftScale : primaryScale);

        return dataScale.yToValue(relY);
      },
      snapX: (x: number) => surface.snapX(x),
      snapY: (y: number) => surface.snapY(y),
    };
  };

  const dispatchPluginPointer = (type: PluginPointerEvent['type'], x: number, y: number): boolean => {
    if (plugins.length === 0) return false;
    const state = buildPluginState(overlay);
    if (!state) return false;
    const inPlot = isInsidePlot(x, y);
    const time = inPlot ? state.xToTime(x) : null;
    const event: PluginPointerEvent = { type, x, y, time, inPlot };
    for (const plugin of plugins) {
      const consumed = plugin.onPointer?.(event, state);
      if (consumed === true) return true; // Event consumed, chart should not process
    }
    return false;
  };

  const syncLodTail = (series: InternalSeries, baseLength: number): void => {
    const data = series.data;
    if (isChunkedStore(data)) return;
    const time = data.times();
    const value = data.values();
    const currentLength = data.length;
    if (currentLength <= 0) return;

    if (currentLength > baseLength) {
      withLodWork(() => series.lod.appendBatch(time, value, baseLength, currentLength));
    } else {
      withLodWork(() => series.lod.updateLast(time, value, currentLength));
    }
  };

  const applyLodLevels = (
    series: InternalSeries,
    levels: LodWorkerLevel[],
    baseLength: number,
  ): void => {
    const data = series.data;
    if (isChunkedStore(data)) return;
    if (levels.length === 0) {
      series.lod.clear();
      return;
    }
    withLodWork(() => series.lod.loadLevels(levels, data.times(), data.values(), baseLength));
    syncLodTail(series, baseLength);
    bumpSeriesRevision(series);
    decimator.clearCache();
    scheduleSeriesInvalidate();
  };

  const applyChunkLodLevels = (
    series: InternalSeries,
    entry: ChunkLodEntry,
    chunk: { time: Float64Array; value: Float64Array; length: number; endTime: number },
    levels: LodWorkerLevel[],
  ): void => {
    const previousBytes = entry.bytes;
    if (levels.length === 0) {
      entry.lod.clear();
    } else {
      withLodWork(() => entry.lod.loadLevels(levels, chunk.time, chunk.value, chunk.length));
    }
    entry.length = chunk.length;
    entry.endTime = chunk.endTime;
    entry.lastValue = resolveChunkLastValue(chunk);
    entry.bytes = entry.lod.bytesUsed;
    chunkedLodBytes += entry.bytes - previousBytes;
    bumpSeriesRevision(series);
    evictChunkLodsIfNeeded();
    chunkedDecimator.clearCache();
    scheduleSeriesInvalidate();
  };

  const startChunkLodBuild = (
    series: InternalSeries,
    chunk: {
      startTime: number;
      endTime: number;
      length: number;
      time: Float64Array;
      value: Float64Array;
    },
    entry: ChunkLodEntry,
  ): void => {
    cancelChunkLodBuild(entry);
    const token: CancellableToken = { canceled: false };
    entry.pendingBuildToken = token;

    const bucketSizes = resolveLodBucketSizes(chunk.length, lodOptions.maxLevels);
    if (bucketSizes.length === 0) {
      resetChunkLodEntry(entry);
      if (entry.pendingBuildToken === token) {
        entry.pendingBuildToken = null;
      }
      return;
    }

    const levels: LodWorkerLevel[] = [];
    const expectedLength = chunk.length;
    const expectedEndTime = chunk.endTime;
    const expectedLastValue = resolveChunkLastValue(chunk);
    const startTime = chunk.startTime;

    const isCurrent = (): boolean => {
      if (token.canceled) return false;
      if (!isChunkedStore(series.data)) return false;
      const current = series.chunkLods.get(startTime);
      if (!current || current !== entry) return false;
      return (
        current.length === expectedLength &&
        current.endTime === expectedEndTime &&
        Object.is(current.lastValue, expectedLastValue)
      );
    };

    const run = async () => {
      for (let i = bucketSizes.length - 1; i >= 0; i -= 1) {
        const bucketSize = bucketSizes[i];
        if (!bucketSize) continue;
        const level = await buildLodLevelChunked(
          chunk.time,
          chunk.value,
          chunk.length,
          bucketSize,
          token,
        );
        if (!level || !isCurrent()) {
          token.canceled = true;
          break;
        }
        levels.unshift(level);
        applyChunkLodLevels(series, entry, chunk, levels);
      }
      if (entry.pendingBuildToken === token) {
        entry.pendingBuildToken = null;
      }
    };

    void run();
  };

  const requestChunkLodBuild = (
    series: InternalSeries,
    chunk: {
      startTime: number;
      endTime: number;
      length: number;
      time: Float64Array;
      value: Float64Array;
    },
    entry: ChunkLodEntry,
    worker: Worker,
  ): void => {
    cancelChunkLodRequest(entry);
    const requestId = (lodRequestId += 1);
    entry.pendingRequestId = requestId;

    const useShared = canUseSharedArrayBuffer();
    const timeCopy = useShared
      ? copyToSharedArray(chunk.time, chunk.length)
      : chunk.time.slice(0, chunk.length);
    const valueCopy = useShared
      ? copyToSharedArray(chunk.value, chunk.length)
      : chunk.value.slice(0, chunk.length);
    chunkLodRequests.set(requestId, {
      series,
      chunkStart: chunk.startTime,
      length: chunk.length,
      endTime: chunk.endTime,
      levels: [],
    });
    chunkLodRequestTimes.set(requestId, nowTime());
    const transfer = useShared ? [] : [timeCopy.buffer, valueCopy.buffer];
    try {
      worker.postMessage(
        {
          requestId,
          time: timeCopy,
          value: valueCopy,
          length: chunk.length,
          maxLevels: lodOptions.maxLevels,
          minPoints: lodOptions.minPoints,
          progressive: true,
        },
        transfer,
      );
    } catch {
      disableLodWorker();
      entry.pendingRequestId = null;
      startChunkLodBuild(series, chunk, entry);
    }
  };

  const buildLodLevelsChunked = async (
    series: InternalSeries,
    time: Float64Array,
    value: Float64Array,
    length: number,
    token: LodBuildToken,
  ): Promise<void> => {
    const bucketSizes = resolveLodBucketSizes(length, lodOptions.maxLevels);
    if (bucketSizes.length === 0) {
      series.lod.clear();
      return;
    }

    const levels: LodWorkerLevel[] = [];
    for (let i = bucketSizes.length - 1; i >= 0; i -= 1) {
      const level = await buildLodLevelChunked(time, value, length, bucketSizes[i]!, token);
      if (!level || token.canceled || series.lodVersion !== token.version) return;
      levels.unshift(level);
      applyLodLevels(series, levels, length);
    }
  };

  const getLodWorker = (): Worker | null => {
    if (lodWorkerDisabled) return null;
    if (lodWorker !== undefined) return lodWorker;
    lodWorker = createLodWorker();
    if (lodWorker) {
      lodWorker.onerror = () => disableLodWorker();
      lodWorker.onmessageerror = () => disableLodWorker();
      lodWorker.onmessage = (event: MessageEvent<LodWorkerResponse>) => {
        const data = event.data;
        const chunkRequest = chunkLodRequests.get(data.requestId);
        if (chunkRequest) {
          const { series, chunkStart, length, endTime } = chunkRequest;
          if (!isChunkedStore(series.data)) {
            chunkLodRequests.delete(data.requestId);
            chunkLodRequestTimes.delete(data.requestId);
            return;
          }
          const entry = series.chunkLods.get(chunkStart);
          if (!entry || entry.pendingRequestId !== data.requestId) {
            chunkLodRequests.delete(data.requestId);
            chunkLodRequestTimes.delete(data.requestId);
            return;
          }
          const chunk = findChunkByStartTime(series.data, chunkStart);
          if (!chunk || chunk.length !== length || chunk.endTime !== endTime) {
            entry.pendingRequestId = null;
            chunkLodRequests.delete(data.requestId);
            chunkLodRequestTimes.delete(data.requestId);
            return;
          }
          const incoming = data.levels ?? [];
          if (incoming.length > 0) {
            chunkRequest.levels.push(...incoming);
            applyChunkLodLevels(series, entry, chunk, chunkRequest.levels);
          }
          if (data.done) {
            entry.pendingRequestId = null;
            chunkLodRequests.delete(data.requestId);
            const startedAt = chunkLodRequestTimes.get(data.requestId);
            if (startedAt !== undefined) {
              chunkLodWorkerTotalMs += Math.max(0, nowTime() - startedAt);
              chunkLodWorkerCompleted += 1;
              chunkLodRequestTimes.delete(data.requestId);
            }
          }
          return;
        }
        const request = lodRequests.get(data.requestId);
        if (!request) {
          lodRequestTimes.delete(data.requestId);
          return;
        }
        const { series, version, length } = request;
        if (series.lodVersion !== version) {
          lodRequests.delete(data.requestId);
          lodRequestTimes.delete(data.requestId);
          return;
        }
        const incoming = data.levels ?? [];
        if (incoming.length > 0) {
          request.levels.push(...incoming);
          applyLodLevels(series, request.levels, length);
        }
        if (data.done) {
          lodRequests.delete(data.requestId);
          const startedAt = lodRequestTimes.get(data.requestId);
          if (startedAt !== undefined) {
            lodWorkerTotalMs += Math.max(0, nowTime() - startedAt);
            lodWorkerCompleted += 1;
            lodRequestTimes.delete(data.requestId);
          }
          if (series.lodBuildToken) {
            series.lodBuildToken.canceled = true;
            series.lodBuildToken = null;
          }
        }
      };
    }
    return lodWorker;
  };

  const startLodBuild = (series: InternalSeries): void => {
    if (isChunkedStore(series.data)) {
      series.lod.clear();
      return;
    }
    const length = series.data.length;
    if (length < lodOptions.minPoints) {
      series.lod.clear();
      return;
    }

    const time = series.data.times();
    const value = series.data.values();
    const token: LodBuildToken = {
      version: series.lodVersion,
      length,
      canceled: false,
    };
    if (series.lodBuildToken) {
      series.lodBuildToken.canceled = true;
    }
    series.lodBuildToken = token;

    const worker = getLodWorker();
    if (worker) {
      if (LOD_PREVIEW_LEVELS > 0) {
        const bucketSizes = resolveLodBucketSizes(length, lodOptions.maxLevels);
        const previewSize = bucketSizes[bucketSizes.length - 1];
        if (previewSize) {
          void buildLodLevelChunked(time, value, length, previewSize, token).then((level) => {
            if (!level || token.canceled || series.lodVersion !== token.version) return;
            applyLodLevels(series, [level], length);
          });
        }
      }

      for (const [requestId, request] of lodRequests) {
        if (request.series === series) {
          lodRequests.delete(requestId);
          lodRequestTimes.delete(requestId);
        }
      }

      const requestId = (lodRequestId += 1);
      const useShared = canUseSharedArrayBuffer();
      const timeCopy = useShared ? copyToSharedArray(time, length) : time.slice(0, length);
      const valueCopy = useShared ? copyToSharedArray(value, length) : value.slice(0, length);
      lodRequests.set(requestId, { series, version: series.lodVersion, length, levels: [] });
      lodRequestTimes.set(requestId, nowTime());
      const transfer = useShared ? [] : [timeCopy.buffer, valueCopy.buffer];
      try {
        worker.postMessage(
          {
            requestId,
            time: timeCopy,
            value: valueCopy,
            length,
            maxLevels: lodOptions.maxLevels,
            minPoints: lodOptions.minPoints,
            progressive: true,
          },
          transfer,
        );
      } catch {
        disableLodWorker();
        void buildLodLevelsChunked(series, time, value, length, token).then(() => {
          if (token.canceled || series.lodVersion !== token.version) return;
          series.lodBuildToken = null;
        });
      }
    } else {
      void buildLodLevelsChunked(series, time, value, length, token).then(() => {
        if (token.canceled || series.lodVersion !== token.version) return;
        series.lodBuildToken = null;
      });
    }
  };

  const initSeriesWorker = (): void => {
    if (!seriesWorkerRequested || !seriesWorkerSupported || seriesWorkerActive || seriesWorkerDisabled) return;
    const worker = createSeriesWorker();
    if (!worker) return;
    try {
      const offscreen = seriesLayer.canvas.transferControlToOffscreen();
      seriesLayer.detachContext();
      const size = seriesLayer.getSize();
      const message: SeriesWorkerMessage = {
        type: 'init',
        canvas: offscreen,
        pixelWidth: size.pixelWidth,
        pixelHeight: size.pixelHeight,
        dpr: size.dpr,
      };
      worker.onerror = () => disableSeriesWorker();
      worker.onmessageerror = () => disableSeriesWorker();
      worker.postMessage(message, [offscreen]);
      seriesWorker = worker;
      seriesWorkerActive = true;
    } catch {
      worker.terminate();
      seriesWorker = null;
      seriesWorkerActive = false;
      seriesWorkerDisabled = true;
      seriesLayer.restoreContext();
      setSeriesLayerHidden(false);
    }
  };

  const postSeriesWorkerResize = (): void => {
    if (!seriesWorkerActive || !seriesWorker) return;
    const size = seriesLayer.getSize();
    const message: SeriesWorkerMessage = {
      type: 'resize',
      pixelWidth: size.pixelWidth,
      pixelHeight: size.pixelHeight,
      dpr: size.dpr,
    };
    try {
      seriesWorker.postMessage(message);
    } catch {
      disableSeriesWorker();
    }
  };

  const nowTime = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  const readMemoryStats = (): MemoryStats | null => {
    if (typeof performance === 'undefined') return null;
    const perf = performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
      measureUserAgentSpecificMemory?: () => Promise<{ bytes?: number }>;
    };
    const heap = perf.memory
      ? {
        used: perf.memory.usedJSHeapSize ?? null,
        total: perf.memory.totalJSHeapSize ?? null,
        limit: perf.memory.jsHeapSizeLimit ?? null,
      }
      : null;
    const measure = perf.measureUserAgentSpecificMemory;
    if (typeof measure === 'function' && !workingSetPending) {
      workingSetPending = true;
      const t = nowTime();
      void measure()
        .then((result) => {
          lastWorkingSetBytes = typeof result?.bytes === 'number' ? result.bytes : null;
          lastWorkingSetAt = t;
        })
        .catch(() => {
          lastWorkingSetBytes = null;
          lastWorkingSetAt = t;
        })
        .finally(() => {
          workingSetPending = false;
        });
    }
    const workingSet =
      lastWorkingSetAt !== null || lastWorkingSetBytes !== null
        ? { bytes: lastWorkingSetBytes, measuredAt: lastWorkingSetAt }
        : null;
    if (!heap && !workingSet) return null;
    return {
      ...(heap ? { heap } : {}),
      ...(workingSet ? { workingSet } : {}),
    };
  };

  const readRetentionStats = (): RetentionStats => {
    let dataBytes = 0;
    let dataChunks = 0;
    let lodBytes = 0;
    let lodOnlyBytes = 0;
    let lodOnlyChunks = 0;

    for (const series of seriesList) {
      if (isChunkedStore(series.data)) {
        dataBytes += series.data.bytesUsed;
        dataChunks += series.data.chunkCount;
        for (const entry of series.chunkLods.values()) {
          lodBytes += entry.bytes;
          if (entry.lodOnly) {
            lodOnlyChunks += 1;
            lodOnlyBytes += entry.bytes;
          }
        }
      } else {
        lodBytes += series.lod.bytesUsed;
      }
    }

    return {
      rawRetentionMs,
      dataBytes,
      dataChunks,
      lodBytes,
      lodOnlyBytes,
      lodOnlyChunks,
    };
  };

  const recordLodWork = (startedAt: number): void => {
    const elapsed = Math.max(0, nowTime() - startedAt);
    lodWorkMsFrame += elapsed;
    lodWorkMsTotal += elapsed;
    lodWorkOps += 1;
    lodWorkOpsFrame += 1;
  };

  const withLodWork = <T>(fn: () => T): T => {
    const startedAt = nowTime();
    const result = fn();
    recordLodWork(startedAt);
    return result;
  };

  const markInteraction = (kind: 'pan' | 'zoom'): void => {
    const now = nowTime();
    interactionActiveUntil = Math.max(interactionActiveUntil, now + INTERACTION_IDLE_MS);
    if (kind === 'zoom') {
      zoomInteractionUntil = Math.max(zoomInteractionUntil, now + INTERACTION_IDLE_MS);
    }
  };

  const isInteractionActive = (): boolean =>
    panActive || inertiaActive || nowTime() < interactionActiveUntil;

  const isZoomInteractionActive = (): boolean => nowTime() < zoomInteractionUntil;

  const updateQualityLevel = (interactionActive: boolean): void => {
    if (isZoomInteractionActive()) {
      qualityTransition.forceTransition(0);
      renderQualityLevel = 0;
      qualityHoldFrames = 0;
      return;
    }

    // During pan: use dynamic quality based on frame cost, not forced degradation
    if (panActive) {
      const budget = INTERACTION_BUDGET_MS;
      let target: 0 | 1 | 2 = 0;

      if (lastFrameCostMs > budget * 1.8) {
        target = 2; // Heavy degradation if struggling
      } else if (lastFrameCostMs > budget * 1.2) {
        target = 1; // Light degradation
      }
      // else target = 0 (full quality if fast enough)

      // Use transition manager - handles immediate transitions for increases (performance critical)
      // and gradual transitions for decreases (smooth visual experience)
      const transitionedLevel = qualityTransition.update(target);
      renderQualityLevel = transitionedLevel as 0 | 1 | 2;

      // Update hold frames based on final level
      if (renderQualityLevel > 0) {
        qualityHoldFrames = QUALITY_HOLD_FRAMES;
      }
      return;
    }

    if (!interactionActive) {
      if (qualityHoldFrames > 0) {
        qualityHoldFrames -= 1;
      } else {
        // Use transition manager for gradual return to high quality (level 0)
        const transitionedLevel = qualityTransition.update(0);
        renderQualityLevel = transitionedLevel as 0 | 1 | 2;
        if (renderQualityLevel === 0) {
          qualityHoldFrames = 0;
        }
      }
      return;
    }

    const budget = INTERACTION_BUDGET_MS;
    let target: 0 | 1 | 2 = 0;
    if (lastFrameCostMs > budget * 1.6) {
      target = 2;
    } else if (lastFrameCostMs > budget) {
      target = 1;
    }

    // Use transition manager - handles immediate transitions for increases (performance critical)
    // and gradual transitions for decreases (smooth visual experience)
    const transitionedLevel = qualityTransition.update(target);
    renderQualityLevel = transitionedLevel as 0 | 1 | 2;

    // Update hold frames based on final level
    if (renderQualityLevel > 0) {
      qualityHoldFrames = QUALITY_HOLD_FRAMES;
    } else {
      qualityHoldFrames = 0;
    }

    if (qualityHoldFrames > 0) {
      qualityHoldFrames -= 1;
    }
  };

  const elasticClampEnabled = timeScaleOptions.elasticClamp ?? false;
  const baseElasticMaxRatio =
    typeof timeScaleOptions.elasticMaxRatio === 'number' && Number.isFinite(timeScaleOptions.elasticMaxRatio)
      ? clamp(timeScaleOptions.elasticMaxRatio, 0, 0.5)
      : 0.12;
  let appliedElasticMaxRatio = baseElasticMaxRatio;
  const elasticIdleMs = 140;
  const elasticReturnMs = 180;
  const elasticReturnMsPan = 60;
  let elasticIdleTimer: number | null = null;
  let elasticReturnHandle: number | null = null;
  let elasticReturnTimeout = false;
  let elasticMode: 'pan' | 'zoom' | null = null;
  const panElasticSpanRatio = Math.max(0.01, Math.min(0.08, panOverscanRatio * 0.06));

  const applyElasticMaxRatio = (ratio: number): void => {
    const clamped = clamp(ratio, 0, 0.5);
    if (Math.abs(clamped - appliedElasticMaxRatio) < 1e-6) return;
    appliedElasticMaxRatio = clamped;
    xScale.setOptions({ elasticMaxRatio: clamped });
  };

  const updateElasticMaxRatio = (mode: 'pan' | 'zoom' | null): void => {
    if (!elasticClampEnabled) return;
    if (mode !== 'pan') {
      applyElasticMaxRatio(baseElasticMaxRatio);
      return;
    }
    if (!timeBoundsRange) {
      applyElasticMaxRatio(baseElasticMaxRatio);
      return;
    }
    const maxSpan = timeBoundsRange.to - timeBoundsRange.from;
    const range = xScale.getVisibleRange();
    const span = range.to - range.from;
    if (!Number.isFinite(maxSpan) || !Number.isFinite(span) || maxSpan <= 0 || span <= 0) {
      applyElasticMaxRatio(baseElasticMaxRatio);
      return;
    }
    const spanLimit = span * panElasticSpanRatio;
    const ratio = spanLimit / maxSpan;
    applyElasticMaxRatio(Math.min(baseElasticMaxRatio, ratio));
  };

  const setElasticMode = (mode: 'pan' | 'zoom' | null): void => {
    if (elasticMode === mode) return;
    elasticMode = mode;
    updateElasticMaxRatio(mode);
  };

  const clearElasticIdleTimer = () => {
    if (elasticIdleTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(elasticIdleTimer);
    }
    elasticIdleTimer = null;
  };

  const cancelElasticReturn = () => {
    if (elasticReturnHandle !== null) {
      if (elasticReturnTimeout) {
        clearTimeout(elasticReturnHandle);
      } else if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(elasticReturnHandle);
      }
    }
    elasticReturnHandle = null;
    elasticReturnTimeout = false;
  };

  const scheduleElasticReturn = (delayMs = elasticIdleMs) => {
    if (!elasticClampEnabled || typeof window === 'undefined') return;
    clearElasticIdleTimer();
    elasticIdleTimer = window.setTimeout(() => {
      elasticIdleTimer = null;
      startElasticReturn();
    }, delayMs);
  };

  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const linearEase = (t: number) => t;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const isSameRange = (a: VisibleTimeRange, b: VisibleTimeRange) =>
    Math.abs(a.from - b.from) < 1e-6 && Math.abs(a.to - b.to) < 1e-6;
  const resolveElasticRange = (
    range: VisibleTimeRange,
  ): { clamped: VisibleTimeRange; elasticActive: boolean } => {
    if (!elasticClampEnabled) {
      return { clamped: range, elasticActive: false };
    }
    const clamped = xScale.getClampedRange(range);
    if (isSameRange(range, clamped)) {
      return { clamped: range, elasticActive: false };
    }
    return { clamped, elasticActive: true };
  };

  const startElasticReturn = () => {
    if (!elasticClampEnabled) return;
    if (!timeBoundsRange) {
      xScale.setElasticActive(false);
      setElasticMode(null);
      return;
    }
    const current = xScale.getVisibleRange();
    const target = xScale.getClampedRange(current);
    if (isSameRange(current, target)) {
      xScale.setElasticActive(false);
      setElasticMode(null);
      return;
    }

    cancelElasticReturn();
    xScale.setElasticActive(true);
    const start = nowTime();
    const duration = elasticMode === 'pan' ? elasticReturnMsPan : elasticReturnMs;
    const ease = elasticMode === 'pan' ? linearEase : easeOutCubic;
    const step = (time: number) => {
      const t = Math.min(1, Math.max(0, (time - start) / duration));
      const eased = ease(t);
      const next = {
        from: lerp(current.from, target.from, eased),
        to: lerp(current.to, target.to, eased),
      };
      xScale.setVisibleRange(next);
      hasCustomVisibleRange = true;
      emitVisibleRangeChange();
      invalidate(InvalidationFlag.All);
      if (t < 1) {
        if (typeof requestAnimationFrame === 'function') {
          elasticReturnTimeout = false;
          elasticReturnHandle = requestAnimationFrame(step);
        } else {
          elasticReturnTimeout = true;
          elasticReturnHandle = setTimeout(() => step(nowTime()), 16);
        }
        return;
      }
      elasticReturnHandle = null;
      elasticReturnTimeout = false;
      xScale.setElasticActive(false);
      setElasticMode(null);
    };

    if (typeof requestAnimationFrame === 'function') {
      elasticReturnTimeout = false;
      elasticReturnHandle = requestAnimationFrame(step);
    } else {
      elasticReturnTimeout = true;
      elasticReturnHandle = setTimeout(() => step(nowTime()), 16);
    }
  };

  const markElasticInteraction = (kind: 'pan' | 'zoom') => {
    if (!elasticClampEnabled) return;
    if (kind === 'zoom') {
      setElasticMode('zoom');
      xScale.setElasticActive(true);
      cancelElasticReturn();
      scheduleElasticReturn();
      return;
    }
    setElasticMode(null);
    xScale.setElasticActive(false);
    cancelElasticReturn();
    clearElasticIdleTimer();
  };

  const resolvePanOverscrollLimit = (plotWidth: number): number => {
    if (!Number.isFinite(plotWidth) || plotWidth <= 0) {
      return PAN_OVERSCROLL_MIN_PX;
    }
    return clamp(plotWidth * PAN_OVERSCROLL_LIMIT_RATIO, PAN_OVERSCROLL_MIN_PX, PAN_OVERSCROLL_MAX_PX);
  };

  const rubberBandPx = (delta: number, limit: number): number => {
    if (!Number.isFinite(delta) || delta === 0) return 0;
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    const sign = delta < 0 ? -1 : 1;
    const abs = Math.abs(delta);
    return sign * (abs * limit) / (abs + limit);
  };

  const updatePanOverscrollPx = (plotWidth: number): boolean => {
    const limit = resolvePanOverscrollLimit(plotWidth);
    const next = rubberBandPx(panOverscrollRaw, limit);
    const changed = Math.abs(next - panOverscrollPx) > 0.05;
    panOverscrollPx = next;
    return changed;
  };

  const resetPanOverscroll = () => {
    panOverscrollRaw = 0;
    panOverscrollPx = 0;
  };

  const cancelPanOverscrollReturn = () => {
    if (panOverscrollReturnHandle !== null) {
      if (panOverscrollReturnTimeout) {
        clearTimeout(panOverscrollReturnHandle);
      } else if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(panOverscrollReturnHandle);
      }
    }
    panOverscrollReturnHandle = null;
    panOverscrollReturnTimeout = false;
  };

  const startPanOverscrollReturn = () => {
    if (panOverscrollPx === 0) {
      resetPanOverscroll();
      return;
    }
    cancelPanOverscrollReturn();
    const start = panOverscrollPx;
    const startedAt = nowTime();
    const duration = PAN_OVERSCROLL_RETURN_MS;
    panOverscrollRaw = 0;
    const step = (time: number) => {
      const t = Math.min(1, Math.max(0, (time - startedAt) / duration));
      const eased = easeOutCubic(t);
      panOverscrollPx = start * (1 - eased);
      invalidate(InvalidationFlag.Series | InvalidationFlag.Overlay | InvalidationFlag.Underlay);
      if (t < 1) {
        if (typeof requestAnimationFrame === 'function') {
          panOverscrollReturnTimeout = false;
          panOverscrollReturnHandle = requestAnimationFrame(step);
        } else {
          panOverscrollReturnTimeout = true;
          panOverscrollReturnHandle = setTimeout(() => step(nowTime()), 16);
        }
        return;
      }
      panOverscrollReturnHandle = null;
      panOverscrollReturnTimeout = false;
      resetPanOverscroll();
    };

    if (typeof requestAnimationFrame === 'function') {
      panOverscrollReturnTimeout = false;
      panOverscrollReturnHandle = requestAnimationFrame(step);
    } else {
      panOverscrollReturnTimeout = true;
      panOverscrollReturnHandle = setTimeout(() => step(nowTime()), 16);
    }
  };

  const cancelInertia = () => {
    if (inertiaHandle !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(inertiaHandle);
      } else {
        clearTimeout(inertiaHandle);
      }
    }
    const wasActive = inertiaActive;
    inertiaHandle = null;
    inertiaActive = false;
    if (wasActive && dragPointerId === null && activeTouches.size === 0) {
      endPan();
    }
  };

  const resetPanVelocity = () => {
    panVelocityX = 0;
    lastPanTime = 0;
    lastPanSource = null;
  };

  const requestCoherentFrames = (frames = 2): void => {
    if (!Number.isFinite(frames) || frames <= 0) return;
    forceCoherentFrames = Math.max(forceCoherentFrames, Math.round(frames));
  };

  const setSeriesLayerHidden = (hidden: boolean): void => {
    if (seriesLayerHidden === hidden) return;
    seriesLayerHidden = hidden;
    seriesLayer.canvas.style.opacity = hidden ? '0' : '1';
    if (hidden) {
      const ctx = seriesLayer.context;
      if (ctx) {
        const size = seriesLayer.getSize();
        ctx.clearRect(0, 0, size.cssWidth, size.cssHeight);
      }
    }
  };

  const clearPanLayer = (): void => {
    const ctx = panLayer.context;
    if (!ctx) {
      panCacheActive = false;
      return;
    }
    const size = panLayer.getSize();
    ctx.clearRect(0, 0, size.cssWidth, size.cssHeight);
    panCacheActive = false;
  };

  const invalidatePanCache = (): void => {
    panCaches.clear();
    clearPanLayer();
    invalidate(InvalidationFlag.Series);
  };

  const captureAxisFreeze = (): void => {
    if (!panFreezeAxis || frozenAxisRanges) return;
    const snapshot = new Map<PaneId, AxisRangeSnapshot>();
    for (const pane of paneList) {
      snapshot.set(pane.id, {
        left: {
          ...pane.leftScale.getRange(),
          minPositive: pane.leftScale.getMinPositive(),
        },
        right: {
          ...pane.rightScale.getRange(),
          minPositive: pane.rightScale.getMinPositive(),
        },
      });
    }
    frozenAxisRanges = snapshot;
  };

  // V7: Always freeze Y-axis during horizontal drag (regardless of panFreezeAxis option)
  // This prevents Y-axis auto-scale from fighting with horizontal pan gesture
  const captureAxisFreezeForHorizontalDrag = (): void => {
    if (frozenAxisRanges) return; // Already frozen
    const snapshot = new Map<PaneId, AxisRangeSnapshot>();
    for (const pane of paneList) {
      snapshot.set(pane.id, {
        left: {
          ...pane.leftScale.getRange(),
          minPositive: pane.leftScale.getMinPositive(),
        },
        right: {
          ...pane.rightScale.getRange(),
          minPositive: pane.rightScale.getMinPositive(),
        },
      });
    }
    frozenAxisRanges = snapshot;
  };

  const clearAxisFreeze = (): void => {
    frozenAxisRanges = null;
  };

  // Freeze Y-axis ticks when pan starts (TradingView behavior)
  // Note: With TickCoordinator, ticks are regenerated every frame, so freezing is less critical
  // but we keep this for potential future optimizations
  const freezeYAxisTicks = (): void => {
    if (!layoutState) return;
    frozenYTicksByPane.clear();
    // Ticks are now managed by TickCoordinator - freezing is handled internally
  };

  const beginPan = (): void => {
    if (panActive) return;
    panActive = true;
    cancelPanOverscrollReturn();
    panOverscrollRaw = panOverscrollPx;
    // V7: Always freeze Y-axis during horizontal drag (prevents auto-scale fight with pan gesture)
    // This applies to all panes (main chart + indicator panes)
    captureAxisFreezeForHorizontalDrag();

    // Also apply user preference (if panFreezeAxis option is enabled)
    captureAxisFreeze();

    const beforeRange = xScale.getVisibleRange();
    const { clamped } = resolveElasticRange(beforeRange);
    panBaseRange = clamped;

    // DEBUG: Log pan start state
    console.log('[PAN] beginPan:', {
      beforeRange: { from: beforeRange.from, to: beforeRange.to, span: beforeRange.to - beforeRange.from },
      panBaseRange: { from: panBaseRange.from, to: panBaseRange.to, span: panBaseRange.to - panBaseRange.from },
      panOverscrollPx,
      panOverscrollRaw,
    });

    // Freeze Y-axis ticks for stability during horizontal pan
    freezeYAxisTicks();

    // V8: Do NOT toggle snapping state during pan.
    // Toggling causes bars near pixel boundaries to shift inconsistently.
    // Smooth panning is achieved via sub-pixel cache blit instead.
  };

  const endPan = (): void => {
    if (!panActive) return;
    panActive = false;
    panBaseRange = null;
    clearAxisFreeze();
    clearPanLayer();

    // Clear frozen Y-axis ticks
    frozenYTicksByPane.clear();

    // V8: Snapping state is no longer toggled during pan (see beginPan comment)

    invalidate(InvalidationFlag.All);
    if (panOverscrollPx !== 0) {
      startPanOverscrollReturn();
    } else {
      resetPanOverscroll();
    }
  };

  const scheduleWheelPanEnd = (delayMs = 80): void => {
    if (wheelPanEndHandle !== null && typeof window !== 'undefined') {
      window.clearTimeout(wheelPanEndHandle);
    }
    if (typeof window === 'undefined') return;
    wheelPanEndHandle = window.setTimeout(() => {
      wheelPanEndHandle = null;
      if (dragPointerId !== null || activeTouches.size > 0) return;
      if (panActive) {
        endPan();
      }
    }, delayMs);
  };

  const recordPanVelocity = (deltaX: number, source: PanSource, x: number, y: number, timeMs?: number) => {
    const now = Number.isFinite(timeMs) && (timeMs as number) > 0 ? (timeMs as number) : nowTime();
    if (lastPanTime > 0) {
      const dt = now - lastPanTime;
      if (dt > 0 && dt < 80) {
        const velocity = deltaX / dt;
        panVelocityX = panVelocityX * 0.8 + velocity * 0.2;
      }
    }
    lastPanTime = now;
    lastPanSource = source;
    lastPanX = x;
    lastPanY = y;
  };

  const startInertia = (source: PanSource, timeMs?: number) => {
    if (!inertiaEnabled) return;
    if (panOverscrollPx !== 0 || panOverscrollRaw !== 0) return;
    if (lastPanSource !== source) return;
    if (Math.abs(panVelocityX) < inertiaMinVelocity) return;

    cancelInertia();
    inertiaActive = true;
    inertiaLastTime = Number.isFinite(timeMs) && (timeMs as number) > 0 ? (timeMs as number) : nowTime();

    const step = (time: number) => {
      if (!inertiaActive) return;
      const dt = Math.max(0, time - inertiaLastTime);
      inertiaLastTime = time;
      const decay = Math.pow(inertiaFriction, dt / 16.67);
      panVelocityX *= decay;
      const deltaX = panVelocityX * dt;

      if (Math.abs(panVelocityX) < inertiaMinVelocity || !Number.isFinite(deltaX)) {
        cancelInertia();
        return;
      }

      queueTouchPan(deltaX, 0, lastPanX, lastPanY);

      if (typeof requestAnimationFrame === 'function') {
        inertiaHandle = requestAnimationFrame(step);
      } else {
        inertiaHandle = setTimeout(() => step(nowTime()), 16);
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      inertiaHandle = requestAnimationFrame(step);
    } else {
      inertiaHandle = setTimeout(() => step(nowTime()), 16);
    }
  };

  const queueTouchPan = (
    deltaX: number,
    deltaY: number,
    centerX: number,
    centerY: number,
    source?: PanSource,
    timeMs?: number,
  ) => {
    if (deltaX === 0 && deltaY === 0) return;
    if (source === 'mouse' && !handleScrollPressedMouseMove) return;
    if (source === 'touch' && !handleScrollTouchDrag) return;
    beginPan();
    markInteraction('pan');
    markElasticInteraction('pan');
    if (source) {
      recordPanVelocity(deltaX, source, centerX, centerY, timeMs);
    }
    scheduler.queueTouch({
      kind: 'pan',
      deltaX,
      deltaY,
      scale: 1,
      centerX,
      centerY,
    });
  };

  const queueTouchPinch = (
    deltaX: number,
    deltaY: number,
    scale: number,
    centerX: number,
    centerY: number,
  ) => {
    if (!handleScalePinch) return;
    if (!Number.isFinite(scale) || scale <= 0) return;
    if (deltaX === 0 && deltaY === 0 && scale === 1) return;
    resetPanVelocity();
    cancelInertia();
    markInteraction('zoom');
    markElasticInteraction('zoom');
    scheduler.queueTouch({
      kind: 'pinch',
      deltaX,
      deltaY,
      scale,
      centerX,
      centerY,
    });
  };

  const updateTouchGesture = (timeMs?: number): void => {
    const count = activeTouches.size;
    if (count === 0) {
      lastTouchCenter = null;
      lastTouchDistance = 0;
      lastTouchCount = 0;
      return;
    }

    const points = Array.from(activeTouches.values());
    if (count === 1) {
      const center = points[0]!;
      if (lastTouchCount === 1 && lastTouchCenter) {
        queueTouchPan(
          center.x - lastTouchCenter.x,
          center.y - lastTouchCenter.y,
          center.x,
          center.y,
          'touch',
          timeMs,
        );
      }
      lastTouchCenter = { x: center.x, y: center.y };
      lastTouchDistance = 0;
      lastTouchCount = 1;
      return;
    }

    const a = points[0]!;
    const b = points[1]!;
    const center = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (lastTouchCount >= 2 && lastTouchCenter && lastTouchDistance > 0) {
      const deltaX = center.x - lastTouchCenter.x;
      const deltaY = center.y - lastTouchCenter.y;
      const scale = distance / lastTouchDistance;
      queueTouchPinch(deltaX, deltaY, scale, center.x, center.y);
    }
    lastTouchCenter = center;
    lastTouchDistance = distance;
    lastTouchCount = 2;
  };

  const applyPanDelta = (
    deltaX: number,
    plotWidth: number,
  ): { rangeChanged: boolean; overscrollChanged: boolean } => {
    // DEBUG: Log pan delta application
    const debugBefore = xScale.getVisibleRange();
    console.log('[PAN] applyPanDelta START:', {
      deltaX,
      plotWidth,
      elasticClampEnabled,
      panOverscrollRaw,
      beforeRange: { from: debugBefore.from, to: debugBefore.to, span: debugBefore.to - debugBefore.from },
    });

    if (!elasticClampEnabled) {
      const before = xScale.getVisibleRange();
      xScale.panByPixels(deltaX);
      const after = xScale.getVisibleRange();
      const span = before.to - before.from;
      const actualDeltaX =
        Number.isFinite(span) && span > 0
          ? -((after.from - before.from) / span) * plotWidth
          : 0;
      console.log('[PAN] applyPanDelta (non-elastic):', {
        rangeChanged: Math.abs(actualDeltaX) > 1e-6,
        afterRange: { from: after.from, to: after.to, span: after.to - after.from },
      });
      return { rangeChanged: Math.abs(actualDeltaX) > 1e-6, overscrollChanged: false };
    }

    let remaining = deltaX;
    let rangeChanged = false;
    let overscrollChanged = false;

    if (panOverscrollRaw !== 0) {
      const nextRaw = panOverscrollRaw + remaining;
      if (nextRaw === 0 || Math.sign(panOverscrollRaw) === Math.sign(nextRaw)) {
        panOverscrollRaw = nextRaw;
        remaining = 0;
      } else {
        panOverscrollRaw = 0;
        remaining = nextRaw;
      }
      overscrollChanged = updatePanOverscrollPx(plotWidth) || overscrollChanged;
    }

    if (remaining !== 0) {
      const before = xScale.getVisibleRange();
      xScale.panByPixels(remaining);
      const after = xScale.getVisibleRange();
      const span = before.to - before.from;
      const actualDeltaX =
        Number.isFinite(span) && span > 0
          ? -((after.from - before.from) / span) * plotWidth
          : 0;
      if (Math.abs(actualDeltaX) > 1e-6) {
        rangeChanged = true;
      }
      const unconsumed = remaining - actualDeltaX;
      if (Math.abs(unconsumed) > 1e-6) {
        panOverscrollRaw += unconsumed;
        overscrollChanged = updatePanOverscrollPx(plotWidth) || overscrollChanged;
      }
    }

    // DEBUG: Log elastic pan result
    const debugAfter = xScale.getVisibleRange();
    console.log('[PAN] applyPanDelta (elastic) END:', {
      rangeChanged,
      overscrollChanged,
      panOverscrollRaw,
      afterRange: { from: debugAfter.from, to: debugAfter.to, span: debugAfter.to - debugAfter.from },
    });

    return { rangeChanged, overscrollChanged };
  };

  type IntentResult = {
    changed: boolean;
    flags: InvalidationFlag;
    pan: boolean;
    zoom: boolean;
  };

  const applyIntent = (intent: InputIntent): IntentResult => {
    if (!layoutState) {
      return { changed: false, flags: InvalidationFlag.None, pan: false, zoom: false };
    }
    const plotRect = layoutState.plotRect;
    if (plotRect.width <= 0) return { changed: false, flags: InvalidationFlag.None, pan: false, zoom: false };

    let rangeChanged = false;
    let overscrollChanged = false;
    let pan = false;
    let zoom = false;
    const panLike = panActive || inertiaActive;
    xScale.setPlotWidth(plotRect.width);
    updateAutoMinRange();

    if (intent.wheel) {
      const anchorX = intent.wheel.x - plotRect.x;
      if (intent.wheel.deltaX !== 0) {
        const result = applyPanDelta(intent.wheel.deltaX, plotRect.width);
        rangeChanged = rangeChanged || result.rangeChanged;
        overscrollChanged = overscrollChanged || result.overscrollChanged;
        if (result.rangeChanged || result.overscrollChanged) {
          pan = true;
        }
      }
      if (intent.wheel.deltaY !== 0) {
        // V7: Right-edge zoom - anchor to right edge by default, cursor when Ctrl pressed
        // Ctrl key = cursor anchor, no Ctrl = right edge anchor
        const anchorToRightEdge = !intent.wheel.ctrlKey;
        xScale.zoomByWheel(intent.wheel.deltaY, anchorX, anchorToRightEdge);
        rangeChanged = true;
        zoom = true;
        // Clear coordinate stabilization cache on zoom (coordinates change significantly)
        underlay.clearStabilization();
        seriesLayer.clearStabilization();
        overlay.clearStabilization();
      }
    }

    if (intent.touch) {
      if (intent.touch.deltaX !== 0) {
        const result = applyPanDelta(intent.touch.deltaX, plotRect.width);
        rangeChanged = rangeChanged || result.rangeChanged;
        overscrollChanged = overscrollChanged || result.overscrollChanged;
        if (result.rangeChanged || result.overscrollChanged) {
          pan = true;
        }
      }

      if (intent.touch.deltaY !== 0) {
        const paneState = getPaneAtY(intent.touch.centerY);
        if (paneState) {
          const leftScale = getAxisScale(paneState.id, 'left');
          const rightScale = getAxisScale(paneState.id, 'right');
          const deltaY = intent.touch.deltaY;

          const applyYPan = (axisId: AxisId, scale: PriceScale) => {
            const range = scale.getRange();
            if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) return;
            const span = range.max - range.min;
            const pixelDelta = deltaY / paneState.plotRect.height;
            const valueDelta = span * pixelDelta;

            const nextRange: AxisManualRange = {
              min: range.min + valueDelta,
              max: range.max + valueDelta,
              minPositive: scale.getMinPositive(),
            };
            axisManualRanges.set(getAxisOverrideKey(paneState.id, axisId), nextRange);
          };

          if (hasAxisSeries(paneState.id, 'left')) applyYPan('left', leftScale);
          if (hasAxisSeries(paneState.id, 'right')) applyYPan('right', rightScale);

          rangeChanged = true;
          pan = true;
          invalidatePanCache();
        }
      }

      if (intent.touch.kind === 'pinch' && intent.touch.scale !== 1) {
        const anchorX = intent.touch.centerX - plotRect.x;
        xScale.zoomByScale(intent.touch.scale, anchorX);
        rangeChanged = true;
        zoom = true;
        // Clear coordinate stabilization cache on zoom (coordinates change significantly)
        underlay.clearStabilization();
        seriesLayer.clearStabilization();
        overlay.clearStabilization();
      }
    }

    const changed = rangeChanged || overscrollChanged;

    if (changed && autoScrollEnabled) {
      autoScrollEnabled = false;
    }

    if (changed && externalCrosshair) {
      applyExternalCrosshair(externalCrosshair, false);
    }

    let flags = InvalidationFlag.None;
    if (changed) {
      flags = (flags | InvalidationFlag.Series | InvalidationFlag.Overlay) as InvalidationFlag;
      if (rangeChanged || overscrollChanged) {
        if (!layoutState || zoom) {
          flags = (flags | InvalidationFlag.Layout) as InvalidationFlag;
        } else if (panLike || overscrollChanged) {
          // Always invalidate underlay during pan for smooth grid movement
          // Transform-based grid rendering makes this cheap
          flags = (flags | InvalidationFlag.Underlay) as InvalidationFlag;
        } else if (!panFreezeTicks) {
          flags = (flags | InvalidationFlag.Layout) as InvalidationFlag;
        }
        if (rangeChanged) {
          emitVisibleRangeChange();
        }
      }
    }

    return { changed, flags, pan, zoom };
  };

  const formatSeriesValue = (
    series: InternalSeries,
    value: number | null,
    scale: PriceScale,
  ): string => {
    if (value === null || !Number.isFinite(value)) return '';
    if (series.options.valueFormatter) {
      return series.options.valueFormatter(value);
    }
    return scale.formatValue(value, series.scaleBase);
  };

  const isOhlcSeries = (series: InternalSeries): boolean =>
    series.seriesType === 'candlestick' || series.seriesType === 'bar';

  const resolveNearestIndex = (
    times: Float64Array,
    length: number,
    time: number,
  ): number | null => {
    if (length <= 0) return null;
    const idx = lowerBound(times, length, time);
    if (idx <= 0) return 0;
    if (idx >= length) return length - 1;
    const leftTime = times[idx - 1]!;
    const rightTime = times[idx]!;
    if (!Number.isFinite(leftTime)) return idx;
    if (!Number.isFinite(rightTime)) return idx - 1;
    return Math.abs(leftTime - time) <= Math.abs(rightTime - time) ? idx - 1 : idx;
  };

  const resolveNearestSeriesSample = (
    series: InternalSeries,
    time: number,
  ): { time: number; index: number; value: number | null } | null => {
    if (series.data.length <= 0) return null;
    const idx = series.data.lowerBound(time);
    let best: { time: number; index: number; value: number | null } | null = null;
    const consider = (index: number) => {
      if (index < 0 || index >= series.data.length) return;
      const sampleTime = getSeriesTimeAt(series, index);
      if (sampleTime === null) return;
      const sampleValue = getSeriesValueAt(series, index);
      if (sampleValue === null) return;
      if (!best) {
        best = { time: sampleTime, index, value: sampleValue };
        return;
      }
      const distance = Math.abs(sampleTime - time);
      const bestDistance = Math.abs(best.time - time);
      if (distance < bestDistance || (distance === bestDistance && index < best.index)) {
        best = { time: sampleTime, index, value: sampleValue };
      }
    };
    consider(idx - 1);
    consider(idx);
    return best;
  };

  const resolveNearestSeriesTime = (
    series: InternalSeries,
    time: number,
  ): { time: number; distance: number } | null => {
    if (series.data.length <= 0) return null;
    const idx = series.data.lowerBound(time);
    let bestTime: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestIndex = Number.POSITIVE_INFINITY;
    const consider = (index: number) => {
      if (index < 0 || index >= series.data.length) return;
      const sampleTime = getSeriesTimeAt(series, index);
      if (sampleTime === null) return;
      const distance = Math.abs(sampleTime - time);
      if (distance < bestDistance || (distance === bestDistance && index < bestIndex)) {
        bestTime = sampleTime;
        bestDistance = distance;
        bestIndex = index;
      }
    };
    consider(idx - 1);
    consider(idx);
    if (bestTime === null) return null;
    return { time: bestTime, distance: bestDistance };
  };

  const resolveNearestOhlcSample = (
    series: InternalSeries,
    time: number,
  ): { time: number; index: number; open: number; high: number; low: number; close: number } | null => {
    const store = series.ohlcData;
    if (!store || store.length <= 0) return null;
    const times = store.times();
    const length = store.length;
    const index = resolveNearestIndex(times, length, time);
    if (index === null) return null;
    const t = times[index]!;
    const open = store.opens()[index]!;
    const high = store.highs()[index]!;
    const low = store.lows()[index]!;
    const close = store.closes()[index]!;
    if (
      !Number.isFinite(t) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      return null;
    }
    return { time: t, index, open, high, low, close };
  };

  const resolveNearestTimeTarget = (
    paneId: PaneId,
    time: number,
    range: VisibleTimeRange,
  ): { time: number; series: InternalSeries } | null => {
    const candidates = getPaneSeries(paneId).filter((series) => series.visible);
    let best: { time: number; series: InternalSeries; distance: number } | null = null;
    for (const series of candidates) {
      const sample = resolveNearestSeriesTime(series, time);
      if (!sample) continue;
      if (sample.time < range.from || sample.time > range.to) continue;
      if (
        !best ||
        sample.distance < best.distance ||
        (sample.distance === best.distance && series.order < best.series.order)
      ) {
        best = { time: sample.time, series, distance: sample.distance };
      }
    }
    return best ? { time: best.time, series: best.series } : null;
  };

  const resolveMagnetTarget = (
    paneId: PaneId,
    time: number,
    range: VisibleTimeRange,
    preferOhlc: boolean,
  ): { time: number; series: InternalSeries; value: number | null } | null => {
    const candidates = getPaneSeries(paneId).filter((series) => series.visible);
    const pass = (useOhlc: boolean) => {
      let best: { time: number; series: InternalSeries; value: number | null } | null = null;
      for (const series of candidates) {
        if (useOhlc && !isOhlcSeries(series)) continue;
        const sample = isOhlcSeries(series)
          ? resolveNearestOhlcSample(series, time)
          : resolveNearestSeriesSample(series, time);
        if (!sample) continue;
        if (sample.time < range.from || sample.time > range.to) continue;
        const sampleValue = 'close' in sample ? sample.close : sample.value;
        if (!Number.isFinite(sampleValue ?? Number.NaN)) continue;
        if (!best) {
          best = { time: sample.time, series, value: sampleValue ?? null };
          continue;
        }
        const distance = Math.abs(sample.time - time);
        const bestDistance = Math.abs(best.time - time);
        if (
          distance < bestDistance ||
          (distance === bestDistance && series.order < best.series.order)
        ) {
          best = { time: sample.time, series, value: sampleValue ?? null };
        }
      }
      return best;
    };
    if (preferOhlc) {
      const ohlcBest = pass(true);
      if (ohlcBest) return ohlcBest;
    }
    return pass(false);
  };

  const getSeriesTimeAt = (series: InternalSeries, index: number): number | null => {
    if (index < 0 || index >= series.data.length) return null;
    if (isChunkedStore(series.data)) {
      const value = series.data.getTimeAt(index);
      return value !== null && Number.isFinite(value) ? value : null;
    }
    const times = series.data.times();
    const value = times[index]!;
    return Number.isFinite(value) ? value : null;
  };

  const getSeriesValueAt = (series: InternalSeries, index: number): number | null => {
    if (index < 0 || index >= series.data.length) return null;
    if (isChunkedStore(series.data)) {
      const value = series.data.getValueAt(index);
      return value !== null && Number.isFinite(value) ? value : null;
    }
    const values = series.data.values();
    const value = values[index]!;
    return Number.isFinite(value) ? value : null;
  };

  const isGapBetweenSamples = (series: InternalSeries, time: number, leftIndex: number, rightIndex: number): boolean => {
    if (gapThresholdMs === null) return false;
    if (leftIndex < 0 || rightIndex >= series.data.length) return false;
    const leftTime = getSeriesTimeAt(series, leftIndex);
    const rightTime = getSeriesTimeAt(series, rightIndex);
    if (leftTime === null || rightTime === null) return false;
    return rightTime - leftTime > gapThresholdMs && time > leftTime && time < rightTime;
  };

  const resolveSampleMode = (series: InternalSeries): 'nearest' | 'linear' | 'hold' => {
    const mode = series.options.sampleMode;
    if (mode === 'nearest' || mode === 'linear' || mode === 'hold') return mode;
    return crosshairMode === 'interpolate' ? 'linear' : 'nearest';
  };

  const resolveNearestValue = (
    series: InternalSeries,
    time: number,
    leftIndex: number,
    rightIndex: number,
  ): number | null => {
    let bestValue: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestIndex = Number.POSITIVE_INFINITY;
    const consider = (index: number, sampleTime: number | null, sampleValue: number | null) => {
      if (sampleTime === null || sampleValue === null) return;
      const distance = Math.abs(sampleTime - time);
      if (distance < bestDistance || (distance === bestDistance && index < bestIndex)) {
        bestDistance = distance;
        bestValue = sampleValue;
        bestIndex = index;
      }
    };
    if (leftIndex >= 0) {
      consider(leftIndex, getSeriesTimeAt(series, leftIndex), getSeriesValueAt(series, leftIndex));
    }
    if (rightIndex < series.data.length) {
      consider(rightIndex, getSeriesTimeAt(series, rightIndex), getSeriesValueAt(series, rightIndex));
    }
    return bestValue;
  };

  const resolveInterpolatedValue = (
    series: InternalSeries,
    time: number,
    leftIndex: number,
    rightIndex: number,
  ): number | null => {
    if (leftIndex < 0 || rightIndex >= series.data.length) {
      return resolveNearestValue(series, time, leftIndex, rightIndex);
    }
    const t0 = getSeriesTimeAt(series, leftIndex);
    const t1 = getSeriesTimeAt(series, rightIndex);
    const v0 = getSeriesValueAt(series, leftIndex);
    const v1 = getSeriesValueAt(series, rightIndex);
    if (t0 === null || t1 === null || v0 === null || v1 === null) {
      return resolveNearestValue(series, time, leftIndex, rightIndex);
    }
    if (t1 === t0) return v1;
    const ratio = (time - t0) / (t1 - t0);
    const value = v0 + (v1 - v0) * ratio;
    return Number.isFinite(value) ? value : null;
  };

  const resolveHoldValue = (
    series: InternalSeries,
    time: number,
    leftIndex: number,
    rightIndex: number,
  ): number | null => {
    if (rightIndex < series.data.length) {
      const rightTime = getSeriesTimeAt(series, rightIndex);
      if (rightTime !== null && rightTime === time) {
        return getSeriesValueAt(series, rightIndex);
      }
    }
    if (leftIndex >= 0) {
      return getSeriesValueAt(series, leftIndex);
    }
    return getSeriesValueAt(series, rightIndex);
  };

  const resolveSeriesValue = (series: InternalSeries, time: number): number | null => {
    const length = series.data.length;
    if (length === 0) return null;
    const mode = resolveSampleMode(series);
    const cached = series.crosshairCache;
    if (
      cached &&
      cached.time === time &&
      cached.mode === mode &&
      cached.gapThreshold === gapThresholdMs &&
      cached.renderRevision === series.renderRevision
    ) {
      return cached.value;
    }

    const idx = series.data.lowerBound(time);
    const leftIndex = idx - 1;
    const rightIndex = idx;
    let value: number | null = null;
    if (!isGapBetweenSamples(series, time, leftIndex, rightIndex)) {
      if (mode === 'hold') {
        value = resolveHoldValue(series, time, leftIndex, rightIndex);
      } else if (mode === 'linear') {
        value = resolveInterpolatedValue(series, time, leftIndex, rightIndex);
      } else {
        value = resolveNearestValue(series, time, leftIndex, rightIndex);
      }
    }

    series.crosshairCache = {
      time,
      leftIndex,
      rightIndex,
      value,
      mode,
      gapThreshold: gapThresholdMs,
      renderRevision: series.renderRevision,
    };
    return value;
  };

  const updateCrosshairState = (x: number, y: number, useShiftOverride = true) => {
    if (!layoutState) {
      if (!externalCrosshair) {
        crosshairActive = false;
        crosshairPaneId = null;
        crosshairTime = null;
      }
      return;
    }
    if (!isInsidePlot(x, y)) {
      if (!externalCrosshair) {
        crosshairActive = false;
        crosshairPaneId = null;
        crosshairTime = null;
      }
      return;
    }
    externalCrosshair = null;
    pendingExternalCrosshair = null;
    crosshairActive = true;
    const paneId = getPaneAtY(y)?.id ?? defaultPaneId;
    crosshairPaneId = paneId;
    const plotRect = layoutState.plotRect;
    let snappedX = x;
    let snappedY = y;
    let snappedTime = xScale.xToTime(x - plotRect.x);
    let isInGap = false;  // V7: Track if crosshair is in a gap

    // Crosshair snap: time snaps to existing points for non-interpolated modes; Y stays continuous.
    const baseMagnet = crosshairMode === 'magnet';
    const shiftOverride = useShiftOverride ? crosshairShiftActive : false;
    const magnetOverride = shiftOverride ? !baseMagnet : baseMagnet;
    const preferOhlc = crosshairMode === 'ohlc';
    const useMagnetTarget = preferOhlc || magnetOverride;
    const snapTime = crosshairMode !== 'interpolate' || useMagnetTarget;
    if (snapTime) {
      const originalTime = snappedTime;
      const visibleRange = xScale.getVisibleRange();
      const target = useMagnetTarget
        ? resolveMagnetTarget(paneId, snappedTime, visibleRange, preferOhlc)
        : resolveNearestTimeTarget(paneId, snappedTime, visibleRange);
      if (target) {
        snappedTime = target.time;
        snappedX = plotRect.x + xScale.timeToX(snappedTime);

        // V8 Fix: Track Y axis (price) if target has value (Brace check confirmed)
        const targetWithValue = target as { value?: number | null };
        const targetValue = targetWithValue.value;

        if (typeof targetValue === 'number' && Number.isFinite(targetValue)) {
          const axisId = target.series.axis;
          const scale = getAxisScale(paneId, axisId);
          const paneState = getPaneState(paneId);
          if (scale && paneState) {
            const paneY = paneState.plotRect.y; // Absolute Y of this pane
            // Calculate Y relative to pane height (0 at top)
            // valueToY returns relative Y from top of plot area
            snappedY = paneY + scale.valueToY(targetValue);
          }
        }

        // V7: Detect if we're in a gap (distance to nearest bar is large)
        if (gapThresholdMs !== null && gapThresholdMs > 0) {
          const timeDistance = Math.abs(target.time - originalTime);
          isInGap = timeDistance > gapThresholdMs;
        }

      } else {
        // V7: Edge behavior - if no target found, snap to first/last bar
        const paneSeries = getPaneSeries(paneId).filter((s) => s.visible);
        if (paneSeries.length > 0) {
          // Find first and last bar times across all series
          let firstTime: number | null = null;
          let lastTime: number | null = null;
          for (const series of paneSeries) {
            if (series.data.length === 0) continue;
            const seriesFirst = getSeriesTimeAt(series, 0);
            const seriesLast = getSeriesTimeAt(series, series.data.length - 1);
            if (seriesFirst !== null && (firstTime === null || seriesFirst < firstTime)) {
              firstTime = seriesFirst;
            }
            if (seriesLast !== null && (lastTime === null || seriesLast > lastTime)) {
              lastTime = seriesLast;
            }
          }

          // Snap to first or last bar if mouse is outside data range
          if (firstTime !== null && lastTime !== null) {
            if (snappedTime < firstTime) {
              snappedTime = firstTime;
              snappedX = plotRect.x + xScale.timeToX(snappedTime);
            } else if (snappedTime > lastTime) {
              snappedTime = lastTime;
              snappedX = plotRect.x + xScale.timeToX(snappedTime);
            }
          }
        }
      }
    }

    // V5.2: Crosshair is DIRECT by default (no spring, no smoothing)
    // Optional smoothing can be enabled for magnet/ohlc modes via crosshairOptions.smoothing
    if (crosshairSmoothingEnabled && (crosshairMode === 'magnet' || crosshairMode === 'ohlc') && !isInteractionActive()) {
      // Smooth interpolation for magnet/ohlc modes when smoothing is enabled
      const lerp = crosshairSmoothingFactor;
      crosshairX = crosshairX === 0 ? snappedX : crosshairX * (1 - lerp) + snappedX * lerp;
      crosshairY = crosshairY === 0 ? snappedY : crosshairY * (1 - lerp) + snappedY * lerp;
    } else {
      // Direct update (V5.2 default behavior)
      crosshairX = snappedX;
      crosshairY = snappedY;
    }
    crosshairTime = snappedTime;
    crosshairInGap = isInGap;  // V7: Store gap state for rendering
  };

  const buildMinorLines = (major: number[], min: number, max: number): number[] => {
    const minor: number[] = [];
    for (let i = 0; i < major.length - 1; i += 1) {
      const mid = (major[i]! + major[i + 1]!) * 0.5;
      if (mid > min && mid < max) {
        minor.push(mid);
      }
    }
    return minor;
  };

  const resolveMinSpacing = (positions: number[]): number => {
    if (positions.length < 2) return Number.POSITIVE_INFINITY;
    let minSpacing = Number.POSITIVE_INFINITY;
    for (let i = 1; i < positions.length; i += 1) {
      const delta = Math.abs(positions[i]! - positions[i - 1]!);
      if (delta > 0 && delta < minSpacing) {
        minSpacing = delta;
      }
    }
    return minSpacing;
  };

  const resolveMinorAlpha = (spacing: number): number => {
    if (!Number.isFinite(spacing)) return GRID_MINOR_ALPHA_MIN;
    // Completely hide minor grid when spacing is too small (Phase 2: Adaptive Grid Density)
    if (spacing <= GRID_MINOR_MIN_SPACING) return 0;
    if (spacing >= GRID_MINOR_FADE_SPACING) return GRID_MINOR_ALPHA_MAX;
    const t =
      (spacing - GRID_MINOR_MIN_SPACING) /
      (GRID_MINOR_FADE_SPACING - GRID_MINOR_MIN_SPACING);
    return GRID_MINOR_ALPHA_MIN + t * (GRID_MINOR_ALPHA_MAX - GRID_MINOR_ALPHA_MIN);
  };

  /**
   * Build multi-level minor grid lines (Phase 2: Adaptive Grid Density)
   * - When spacing > 400px: 3 levels (eighth, quarter, half positions)
   * - When spacing > 200px: 2 levels (quarter, half positions)
   * - Otherwise: 1 level (half positions only)
   */
  const buildMultiLevelMinorLines = (
    major: number[],
    min: number,
    max: number,
    spacing: number,
  ): number[] => {
    if (major.length < 2) return [];
    const minor: number[] = [];

    // Determine number of levels based on spacing
    const levels = spacing > 400 ? 3 : spacing > 200 ? 2 : 1;

    for (let i = 0; i < major.length - 1; i += 1) {
      const start = major[i]!;
      const end = major[i + 1]!;
      const span = end - start;

      if (levels >= 3) {
        // Level 3: Eighth positions (1/8, 3/8, 5/8, 7/8)
        for (let j = 1; j < 8; j += 2) {
          const pos = start + (span * j) / 8;
          if (pos > min && pos < max) minor.push(pos);
        }
      }

      if (levels >= 2) {
        // Level 2: Quarter positions (1/4, 3/4)
        for (let j = 1; j < 4; j += 2) {
          const pos = start + (span * j) / 4;
          if (pos > min && pos < max) minor.push(pos);
        }
      }

      // Level 1: Half position (always shown if spacing is sufficient)
      const mid = start + span * 0.5;
      if (mid > min && mid < max) minor.push(mid);
    }

    return minor;
  };

  const buildMinorLinesIfSpacious = (
    major: number[],
    min: number,
    max: number,
    spacing: number,
  ): number[] => {
    // Phase 2: Completely skip minor grid when spacing is too small
    if (!Number.isFinite(spacing) || spacing < GRID_MINOR_MIN_SPACING) return [];

    // Phase 2: Use multi-level minor grid when spacing is large enough
    if (spacing > 200) {
      return buildMultiLevelMinorLines(major, min, max, spacing);
    }

    // Fall back to single-level minor grid (half positions only)
    return buildMinorLines(major, min, max);
  };


  const parseRgb = (color: string): { r: number; g: number; b: number } | null => {
    if (!color) return null;
    if (color[0] === '#') {
      const hex = color.slice(1);
      if (hex.length === 3) {
        const r = parseInt(hex.charAt(0) + hex.charAt(0), 16);
        const g = parseInt(hex.charAt(1) + hex.charAt(1), 16);
        const b = parseInt(hex.charAt(2) + hex.charAt(2), 16);
        return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? { r, g, b } : null;
      }
      if (hex.length === 6) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? { r, g, b } : null;
      }
      return null;
    }

    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return null;
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    return { r, g, b };
  };

  const applyAlpha = (color: string, alpha: number): string => {
    const rgb = parseRgb(color);
    if (!rgb) return color;
    const clamped = clamp(alpha, 0, 1);
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamped})`;
  };

  const resolveLabelTextColor = (color: string): string => {
    const rgb = parseRgb(color);
    if (!rgb) return '#f8fafc';
    const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return luminance > 0.6 ? '#0b0f14' : '#f8fafc';
  };

  const clearWatermarkImage = (): void => {
    watermarkImageToken += 1;
    watermarkImage = null;
    watermarkImageReady = false;
    watermarkImageSrc = null;
  };

  const loadWatermarkImage = (src: string): void => {
    if (watermarkImageSrc === src && watermarkImage) return;
    watermarkImageToken += 1;
    const token = watermarkImageToken;
    watermarkImageSrc = src;
    watermarkImageReady = false;
    const img = new Image();
    img.decoding = 'async';
    watermarkImage = img;
    const finalize = () => {
      if (token !== watermarkImageToken || destroyed) return;
      clearGridCache();
      invalidate(InvalidationFlag.Underlay);
    };
    img.onload = () => {
      if (token !== watermarkImageToken) return;
      watermarkImageReady = true;
      finalize();
    };
    img.onerror = () => {
      if (token !== watermarkImageToken) return;
      watermarkImageReady = false;
      watermarkImage = null;
      finalize();
    };
    img.src = src;
  };

  const applyWatermarkOptions = (next: WatermarkOptions | null): void => {
    if (destroyed) return;
    watermarkOptions = normalizeWatermarkOptions(next);
    const src = watermarkOptions?.imageSrc ?? null;
    if (!src) {
      clearWatermarkImage();
    } else {
      loadWatermarkImage(src);
    }
    invalidate(InvalidationFlag.Underlay);
  };

  const resolveWatermarkImageSize = (
    image: HTMLImageElement,
    plotRect: Rect,
    options: WatermarkOptions,
  ): { width: number; height: number } => {
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) {
      return { width: 0, height: 0 };
    }
    let width = options.imageWidth ?? naturalWidth;
    let height = options.imageHeight ?? naturalHeight;
    if (options.imageWidth && !options.imageHeight) {
      height = (options.imageWidth / naturalWidth) * naturalHeight;
    }
    if (options.imageHeight && !options.imageWidth) {
      width = (options.imageHeight / naturalHeight) * naturalWidth;
    }
    if (!options.imageWidth && !options.imageHeight) {
      const maxWidth = plotRect.width * 0.6;
      const maxHeight = plotRect.height * 0.6;
      const scale = Math.min(1, maxWidth / width, maxHeight / height);
      width *= scale;
      height *= scale;
    }
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
  };

  const renderWatermark = (ctx: CanvasRenderingContext2D, plotRect: Rect): void => {
    const options = watermarkOptions;
    if (!options) return;
    const text = typeof options.text === 'string' ? options.text.trim() : '';
    const hasImage = !!options.imageSrc && watermarkImage && watermarkImageReady;
    if (!text && !hasImage) return;

    const fontSize = options.fontSizePx ?? Math.max(10, Math.round(paint.fontSizePx * 1.3));
    const fontFamily = options.fontFamily ?? paint.fontFamily;
    const font = `${fontSize}px ${fontFamily}`;
    const color = options.color ?? paint.axisText;
    const opacity =
      typeof options.opacity === 'number' && Number.isFinite(options.opacity)
        ? clamp(options.opacity, 0, 1)
        : 0.18;
    const padding = Math.max(12, Math.round(fontSize * 0.8));

    let textWidth = 0;
    let textHeight = 0;
    if (text) {
      textWidth = labelCache.measure(ctx, font, text);
      textHeight = fontSize;
    }

    let imageWidth = 0;
    let imageHeight = 0;
    if (hasImage && watermarkImage) {
      const resolved = resolveWatermarkImageSize(watermarkImage, plotRect, options);
      imageWidth = resolved.width;
      imageHeight = resolved.height;
    }

    const gap = text && imageHeight > 0 ? Math.max(6, Math.round(fontSize * 0.6)) : 0;
    const blockWidth = Math.max(textWidth, imageWidth);
    const blockHeight = imageHeight + gap + textHeight;
    if (blockWidth <= 0 || blockHeight <= 0) return;

    const position = options.position ?? 'center';
    let x = plotRect.x + padding;
    let y = plotRect.y + padding;
    if (position === 'center') {
      x = plotRect.x + (plotRect.width - blockWidth) * 0.5;
      y = plotRect.y + (plotRect.height - blockHeight) * 0.5;
    } else if (position === 'top-right') {
      x = plotRect.x + plotRect.width - padding - blockWidth;
      y = plotRect.y + padding;
    } else if (position === 'bottom-left') {
      x = plotRect.x + padding;
      y = plotRect.y + plotRect.height - padding - blockHeight;
    } else if (position === 'bottom-right') {
      x = plotRect.x + plotRect.width - padding - blockWidth;
      y = plotRect.y + plotRect.height - padding - blockHeight;
    }

    x = clamp(x, plotRect.x, plotRect.x + plotRect.width - blockWidth);
    y = clamp(y, plotRect.y, plotRect.y + plotRect.height - blockHeight);

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();
    ctx.globalAlpha = opacity;

    let cursorY = y;
    const centerX = x + blockWidth * 0.5;
    if (hasImage && watermarkImage) {
      ctx.drawImage(watermarkImage, centerX - imageWidth * 0.5, cursorY, imageWidth, imageHeight);
      cursorY += imageHeight + gap;
    }
    if (text) {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(text, centerX, cursorY);
    }
    ctx.restore();
  };

  const renderSeriesMarkers = (ctx: CanvasRenderingContext2D, xOffset = 0): void => {
    if (!layoutState) return;
    const range = xScale.getVisibleRange();
    const plotRect = layoutState.plotRect;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();
    ctx.font = paint.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (const series of seriesList) {
      if (!series.visible || series.markers.length === 0) continue;
      const paneState = getPaneState(series.paneId);
      if (!paneState) continue;
      const axisScale = getAxisScaleForSeries(series);
      const markers = series.markers;
      const markerTimes = series.markerTimes;
      let start = 0;
      let end = markers.length;
      if (markerTimes && markerTimes.length > 0) {
        start = lowerBound(markerTimes, markerTimes.length, range.from);
        end = upperBound(markerTimes, markerTimes.length, range.to);
      }
      if (start >= end) continue;
      const baseColor = resolveSeriesColor(series, series.order);

      for (let i = start; i < end; i += 1) {
        const marker = markers[i];
        if (!marker) continue;
        const markerTime = Number(marker.time);
        if (!Number.isFinite(markerTime)) continue;
        const sample = isOhlcSeries(series)
          ? resolveNearestOhlcSample(series, markerTime)
          : resolveNearestSeriesSample(series, markerTime);
        if (!sample) continue;
        const sampleTime = sample.time;
        if (sampleTime < range.from || sampleTime > range.to) continue;
        const value = 'close' in sample ? sample.close : sample.value;
        if (!Number.isFinite(value ?? Number.NaN)) continue;
        const scaled = axisScale.toScaleValue(value as number, series.scaleBase);
        const yValue = axisScale.valueToY(scaled);
        if (!Number.isFinite(yValue)) continue;

        const baseX = plotRect.x + xScale.timeToX(sampleTime) + xOffset;
        const baseY = paneState.plotRect.y + yValue;
        const size = Math.max(3, Math.round(marker.size ?? 6));
        const position = marker.position ?? 'above';
        const offset = size * 1.6;
        let y = baseY;
        if (position === 'above') {
          y = baseY - offset;
        } else if (position === 'below') {
          y = baseY + offset;
        }
        const clampedY = clamp(
          y,
          paneState.plotRect.y + size,
          paneState.plotRect.y + paneState.plotRect.height - size,
        );

        const x = overlay.snapX(baseX);
        const snapY = overlay.snapY(clampedY);
        const color = marker.color ?? baseColor;
        ctx.fillStyle = color;

        if (marker.shape === 'square') {
          ctx.fillRect(x - size, snapY - size, size * 2, size * 2);
        } else if (marker.shape === 'arrowDown') {
          ctx.beginPath();
          ctx.moveTo(x - size, snapY - size);
          ctx.lineTo(x + size, snapY - size);
          ctx.lineTo(x, snapY + size);
          ctx.closePath();
          ctx.fill();
        } else if (marker.shape === 'arrowUp') {
          ctx.beginPath();
          ctx.moveTo(x - size, snapY + size);
          ctx.lineTo(x + size, snapY + size);
          ctx.lineTo(x, snapY - size);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(x, snapY, size, 0, Math.PI * 2);
          ctx.fill();
        }

        if (marker.text) {
          ctx.fillStyle = marker.textColor ?? resolveLabelTextColor(color);
          ctx.fillText(marker.text, x + size + 4, snapY);
        }
      }
    }

    ctx.restore();
  };

  const resolvePriceLineDash = (style: PriceLineStyle): number[] => {
    if (style === 'dotted') return [2, 4];
    if (style === 'dashed') return [6, 4];
    return EMPTY_DASH;
  };

  const renderPriceLines = (ctx: CanvasRenderingContext2D, now: number): boolean => {
    if (!layoutState) return false;
    const plotRect = layoutState.plotRect;
    let needsAnimation = false;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();

    for (const series of seriesList) {
      if (!series.visible) continue;
      const options = series.options;
      if (options.priceLineVisible === false) continue;
      if (series.lastValue === null || !Number.isFinite(series.lastValue)) continue;
      const paneState = getPaneState(series.paneId);
      if (!paneState) continue;
      const axisScale = getAxisScaleForSeries(series);
      let value = series.lastValue;
      if (series.lastValueAnimation) {
        const display = resolveSeriesLastValueDisplay(series, now);
        if (display.value === null || !Number.isFinite(display.value)) continue;
        value = display.value;
        if (display.animating) needsAnimation = true;
      }
      if (value === null || !Number.isFinite(value)) continue;
      const scaled = axisScale.toScaleValue(value, series.scaleBase);
      const yValue = axisScale.valueToY(scaled);
      if (!Number.isFinite(yValue)) continue;
      const y = overlay.snapY(paneState.plotRect.y + yValue, 1);
      const color = options.priceLineColor ?? series.lastValueColor ?? resolveSeriesColor(series, series.order);
      const dash = resolvePriceLineDash(options.priceLineStyle ?? 'solid');

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(paneState.plotRect.x, y);
      ctx.lineTo(paneState.plotRect.x + paneState.plotRect.width, y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
    return needsAnimation;
  };

  const renderLastValueMarkers = (ctx: CanvasRenderingContext2D, now: number) => {
    const paddingX = Math.max(7, Math.round(paint.fontSizePx * 0.6));
    const paddingY = Math.max(4, Math.round(paint.fontSizePx * 0.35));
    const pillHeight = paint.fontSizePx + paddingY * 2;
    const axisPadding = paint.axisPadding;
    const gap = Math.max(2, Math.round(pillHeight * 0.2));

    type PillCandidate = {
      series: InternalSeries;
      axis: AxisId;
      paneId: PaneId;
      axisRect: Rect;
      targetY: number;
      pillWidth: number;
      text: string;
      color: string;
    };

    const groups = new Map<
      string,
      { axisRect: Rect; axis: AxisId; paneId: PaneId; items: PillCandidate[] }
    >();
    let maxLeft = axisPillWidthLeft;
    let maxRight = axisPillWidthRight;
    let needsAnimation = false;

    ctx.save();
    ctx.font = paint.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (const series of seriesList) {
      if (!series.visible) continue;
      if (series.options.lastValueVisible === false) continue;
      // Skip volume labels if they are in "Smart Volume" overlay mode
      if (series.options.isVolume) continue;

      const paneState = getPaneState(series.paneId);
      if (!paneState) continue;
      const axisScale = getAxisScaleForSeries(series);
      const { value, animating } = resolveSeriesLastValueDisplay(series, now);
      if (value === null || !Number.isFinite(value)) continue;
      const text = animating ? formatSeriesValue(series, value, axisScale) : series.lastValueText;
      if (!text) continue;
      const axisRect = series.axis === 'right' ? paneState.rightAxisRect : paneState.leftAxisRect;
      if (!axisRect) continue;
      const scaledValue = axisScale.toScaleValue(value, series.scaleBase);
      const yValue = axisScale.valueToY(scaledValue);
      if (!Number.isFinite(yValue)) continue;
      const width = labelCache.measure(ctx, paint.font, text);
      const pillWidth = width + paddingX * 2;
      const color = series.lastValueColor || paint.seriesPalette[0]!;
      if (animating) needsAnimation = true;

      if (series.axis === 'right') {
        maxRight = Math.max(maxRight, pillWidth);
      } else {
        maxLeft = Math.max(maxLeft, pillWidth);
      }

      const key = `${series.paneId}:${series.axis}`;
      const group = groups.get(key) ?? {
        axisRect: { ...axisRect },
        axis: series.axis,
        paneId: series.paneId,
        items: [],
      };
      group.items.push({
        series,
        axis: series.axis,
        paneId: series.paneId,
        axisRect,
        targetY: paneState.plotRect.y + yValue,
        pillWidth,
        text,
        color,
      });
      if (!groups.has(key)) groups.set(key, group);
    }

    if (maxLeft > axisPillWidthLeft + 0.5 || maxRight > axisPillWidthRight + 0.5) {
      axisPillWidthLeft = maxLeft;
      axisPillWidthRight = maxRight;
      invalidate(InvalidationFlag.Layout);
    }

    for (const group of groups.values()) {
      const halfHeight = pillHeight * 0.5;
      const minY = group.axisRect.y + halfHeight;
      const maxY = group.axisRect.y + group.axisRect.height - halfHeight;
      if (maxY <= minY) continue;
      for (const item of group.items) {
        const minX = item.axisRect.x;
        const maxX = item.axisRect.x + item.axisRect.width - item.pillWidth;
        const axisX =
          item.axis === 'right'
            ? item.axisRect.x + axisPadding
            : item.axisRect.x + item.axisRect.width - axisPadding - item.pillWidth;
        const x = minX >= maxX ? minX : Math.min(Math.max(axisX, minX), maxX);
        const centerY = clamp(item.targetY, minY, maxY);
        const y = centerY - halfHeight;
        ctx.fillStyle = item.color;
        ctx.fillRect(x, y, item.pillWidth, pillHeight);
        ctx.fillStyle = resolveLabelTextColor(item.color);
        ctx.fillText(item.text, x + paddingX, centerY);
      }
    }

    ctx.restore();

    if (needsAnimation) {
      invalidate(InvalidationFlag.Overlay);
    }
  };

  const resolveSeriesColor = (series: InternalSeries, order: number): string => {
    if (series.options.color) return series.options.color;
    if (series.options.colorKey) {
      const token = theme[series.options.colorKey];
      if (token) return token;
    }
    if (paint.seriesPalette.length === 0) {
      return theme.seriesPrimary;
    }
    return paint.seriesPalette[order % paint.seriesPalette.length] ?? theme.seriesPrimary;
  };

  const resolveOhlcColors = (
    series: InternalSeries,
    fallback: string,
  ): { up: string; down: string; wick: string | null; borderVisible: boolean } => {
    const options = series.options as CandlestickSeriesOptions | BarSeriesOptions;
    const base = options.color ?? fallback;
    const up = options.upColor ?? base;
    const down = options.downColor ?? base;
    const wick = 'wickColor' in options ? options.wickColor ?? null : null;
    const borderVisible =
      'borderVisible' in options ? options.borderVisible ?? true : false;
    return { up, down, wick, borderVisible };
  };

  const clearSeriesLastValue = (series: InternalSeries): void => {
    series.lastValue = null;
    series.lastValueText = '';
    series.lastValueColor = '';
    series.lastValueDisplay = null;
    series.lastValueAnimation = null;
  };

  const updateSeriesLastValue = (
    series: InternalSeries,
    value: number | null,
    axisScale: PriceScale,
  ): void => {
    const resolved = Number.isFinite(value) ? value : null;
    const previous = series.lastValue;
    const nextText = formatSeriesValue(series, resolved, axisScale);
    const nextColor = resolveSeriesColor(series, series.order);
    const changed =
      !Object.is(previous, resolved) ||
      series.lastValueText !== nextText ||
      series.lastValueColor !== nextColor;
    if (changed) {
      lastValueDirty = true;
    }
    series.lastValue = resolved;
    series.lastValueText = nextText;
    series.lastValueColor = nextColor;

    if (!series.options.lastValueAnimation) {
      series.lastValueDisplay = resolved;
      series.lastValueAnimation = null;
      return;
    }

    if (resolved === null) {
      series.lastValueDisplay = null;
      series.lastValueAnimation = null;
      return;
    }

    if (previous === null || !Number.isFinite(previous)) {
      series.lastValueDisplay = resolved;
      series.lastValueAnimation = null;
      return;
    }

    if (Object.is(previous, resolved)) {
      if (!series.lastValueAnimation) {
        series.lastValueDisplay = resolved;
      }
      return;
    }

    const from =
      series.lastValueDisplay !== null && Number.isFinite(series.lastValueDisplay)
        ? series.lastValueDisplay
        : previous;
    series.lastValueAnimation = { from, startedAt: nowTime() };
    series.lastValueDisplay = from;
  };

  const resolveSeriesLastValueDisplay = (
    series: InternalSeries,
    now: number,
  ): { value: number | null; animating: boolean } => {
    if (!series.options.lastValueAnimation) {
      series.lastValueDisplay = series.lastValue;
      series.lastValueAnimation = null;
      return { value: series.lastValue, animating: false };
    }

    const target = series.lastValue;
    if (target === null || !Number.isFinite(target)) {
      series.lastValueDisplay = null;
      series.lastValueAnimation = null;
      return { value: null, animating: false };
    }

    const anim = series.lastValueAnimation;
    if (!anim) {
      series.lastValueDisplay = target;
      return { value: target, animating: false };
    }

    const elapsed = Math.max(0, now - anim.startedAt);
    const t = Math.min(1, elapsed / LAST_VALUE_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = anim.from + (target - anim.from) * eased;
    series.lastValueDisplay = value;
    if (t >= 1) {
      series.lastValueAnimation = null;
      series.lastValueDisplay = target;
      return { value: target, animating: false };
    }
    return { value, animating: true };
  };

  const cloneFloat64 = (source: Float64Array): Float64Array => {
    const copy = new Float64Array(source.length);
    copy.set(source);
    return copy;
  };

  const cloneRect = (rect: Rect | null): Rect | null =>
    rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;

  const mapOhlcPoint = (point: OhlcDataPoint): DataPoint => ({ t: point.t, v: point.c });
  const mapHistogramPoint = (point: HistogramDataPoint): DataPoint => ({ t: point.t, v: point.v });
  const mapOhlcPoints = (points: OhlcDataPoint[]): DataPoint[] => points.map(mapOhlcPoint);
  const mapHistogramPoints = (points: HistogramDataPoint[]): DataPoint[] =>
    points.map(mapHistogramPoint);
  const ensureOhlcPipeline = (series: InternalSeries): OhlcDataStore => {
    if (!series.ohlcData) {
      series.ohlcData = new OhlcDataStore();
    }
    if (!series.ohlcLod) {
      series.ohlcLod = new OhlcLodPyramid(lodOptions);
    }
    return series.ohlcData;
  };
  const rebuildOhlcLod = (series: InternalSeries, store: OhlcDataStore): void => {
    if (!series.ohlcLod) return;
    withLodWork(() =>
      series.ohlcLod!.rebuild(
        store.times(),
        store.opens(),
        store.highs(),
        store.lows(),
        store.closes(),
        store.length,
      ),
    );
  };
  const appendOhlcLod = (series: InternalSeries, store: OhlcDataStore): void => {
    if (!series.ohlcLod) return;
    withLodWork(() =>
      series.ohlcLod!.append(
        store.times(),
        store.opens(),
        store.highs(),
        store.lows(),
        store.closes(),
        store.length,
      ),
    );
  };
  const appendOhlcLodBatch = (
    series: InternalSeries,
    store: OhlcDataStore,
    prevLength: number,
  ): void => {
    if (!series.ohlcLod) return;
    withLodWork(() =>
      series.ohlcLod!.appendBatch(
        store.times(),
        store.opens(),
        store.highs(),
        store.lows(),
        store.closes(),
        prevLength,
        store.length,
      ),
    );
  };
  const updateOhlcLodLast = (series: InternalSeries, store: OhlcDataStore): void => {
    if (!series.ohlcLod) return;
    withLodWork(() =>
      series.ohlcLod!.updateLast(
        store.times(),
        store.opens(),
        store.highs(),
        store.lows(),
        store.closes(),
        store.length,
      ),
    );
  };
  const patchOhlcLod = (
    series: InternalSeries,
    store: OhlcDataStore,
    range: VisibleTimeRange,
  ): void => {
    if (!series.ohlcLod) return;
    withLodWork(() =>
      series.ohlcLod!.patchExisting(
        store.times(),
        store.opens(),
        store.highs(),
        store.lows(),
        store.closes(),
        store.length,
        range,
      ),
    );
  };
  const resolveHistogramColorValue = (color: HistogramDataPoint['color']): string | null => {
    if (typeof color !== 'string') return null;
    const trimmed = color.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const buildHistogramColorMap = (
    points: HistogramDataPoint[],
    times?: Float64Array,
  ): Map<TimeMs, string> | null => {
    const resolved = new Map<TimeMs, string>();
    for (const point of points) {
      const color = resolveHistogramColorValue(point.color);
      if (color) {
        resolved.set(point.t, color);
      }
    }
    if (resolved.size === 0) return null;
    if (!times) return resolved;
    const filtered = new Map<TimeMs, string>();
    for (let i = 0; i < times.length; i += 1) {
      const t = times[i];
      if (t === undefined) continue;
      const color = resolved.get(t);
      if (color) {
        filtered.set(t, color);
      }
    }
    return filtered.size > 0 ? filtered : null;
  };
  const setHistogramColors = (
    seriesId: string,
    points: HistogramDataPoint[],
    series?: InternalSeries,
  ): void => {
    const times =
      series && !isChunkedStore(series.data) ? series.data.times() : undefined;
    const next = buildHistogramColorMap(points, times);
    if (next) {
      histogramColorBySeries.set(seriesId, next);
    } else {
      histogramColorBySeries.delete(seriesId);
    }
  };
  const updateHistogramColor = (
    seriesId: string,
    point: HistogramDataPoint,
    series?: InternalSeries,
  ): void => {
    if (!Object.prototype.hasOwnProperty.call(point, 'color')) return;
    if (!series || isChunkedStore(series.data)) return;
    const store = series.data;
    const index = store.lowerBound(point.t);
    if (index >= store.length) return;
    const times = store.times();
    if (times[index] !== point.t) return;
    const color = resolveHistogramColorValue(point.color);
    const existing = histogramColorBySeries.get(seriesId);
    if (color) {
      const next = existing ?? new Map<TimeMs, string>();
      next.set(point.t, color);
      histogramColorBySeries.set(seriesId, next);
      return;
    }
    if (existing) {
      existing.delete(point.t);
      if (existing.size === 0) {
        histogramColorBySeries.delete(seriesId);
      }
    }
  };

  const clonePaneLayout = (pane: NonNullable<LayoutResult['panes']>[number]) => ({
    id: pane.id,
    plotRect: cloneRect(pane.plotRect)!,
    leftAxisRect: cloneRect(pane.leftAxisRect),
    rightAxisRect: cloneRect(pane.rightAxisRect),
  });

  const buildScalePayload = (scale: PriceScale, height: number): SeriesWorkerScale => {
    const range = scale.getRange();
    return {
      min: range.min,
      max: range.max,
      type: scale.getEffectiveType(),
      minPositive: scale.getMinPositive(),
      height,
    };
  };

  const resolveTimeLabelWidth = (
    range: VisibleTimeRange,
    measureLabel: (text: string) => number,
    allowMeasure: boolean,
  ): number => {
    if (!allowMeasure && cachedTimeLabelWidth > 0) {
      return cachedTimeLabelWidth;
    }
    const span = range.to - range.from;
    const midTime =
      Number.isFinite(span) && span > 0 ? range.from + span * 0.5 : range.from;
    const widths = [
      Number.isFinite(range.from) ? measureLabel(formatTime(range.from)) : 0,
      Number.isFinite(midTime) ? measureLabel(formatTime(midTime)) : 0,
      Number.isFinite(range.to) ? measureLabel(formatTime(range.to)) : 0,
    ];
    const desired = Math.max(...widths, 0);
    if (cachedTimeLabelWidth <= 0) {
      cachedTimeLabelWidth = desired;
      return desired;
    }
    const lower = cachedTimeLabelWidth * (1 - TIME_LABEL_HYSTERESIS_RATIO);
    const upper = cachedTimeLabelWidth * (1 + TIME_LABEL_HYSTERESIS_RATIO);
    if (desired >= lower && desired <= upper) {
      return cachedTimeLabelWidth;
    }
    cachedTimeLabelWidth = desired;
    return desired;
  };

  // V7: Enhanced axis width hysteresis with shrink delay and threshold
  const resolveAxisWidthWithHysteresis = (
    target: number,
    cached: number,
    axis: 'left' | 'right'
  ): number => {
    if (!Number.isFinite(target) || target <= 0) return 0;
    if (!Number.isFinite(cached) || cached <= 0) return target;

    // Expand immediately (no delay)
    if (target > cached) {
      // Cancel any pending shrink
      const timer = axis === 'left' ? axisWidthShrinkTimerLeft : axisWidthShrinkTimerRight;
      if (timer !== null) {
        window.clearTimeout(timer);
        if (axis === 'left') {
          axisWidthShrinkTimerLeft = null;
          pendingShrinkWidthLeft = null;
        } else {
          axisWidthShrinkTimerRight = null;
          pendingShrinkWidthRight = null;
        }
      }
      return target;
    }

    // Ratio-based hysteresis: if target is within 10% of cached, keep cached
    const lower = cached * (1 - AXIS_WIDTH_HYSTERESIS_RATIO);
    const upper = cached * (1 + AXIS_WIDTH_HYSTERESIS_RATIO);
    if (target >= lower && target <= upper) {
      // Cancel any pending shrink if we're back in hysteresis range
      const timer = axis === 'left' ? axisWidthShrinkTimerLeft : axisWidthShrinkTimerRight;
      if (timer !== null) {
        window.clearTimeout(timer);
        if (axis === 'left') {
          axisWidthShrinkTimerLeft = null;
          pendingShrinkWidthLeft = null;
        } else {
          axisWidthShrinkTimerRight = null;
          pendingShrinkWidthRight = null;
        }
      }
      return cached;
    }

    // Shrink requires delay and threshold (V7)
    const shrinkAmount = cached - target;
    if (shrinkAmount < AXIS_WIDTH_SHRINK_THRESHOLD_PX) {
      // Change is too small, keep cached
      return cached;
    }

    // Schedule shrink after delay
    const timer = axis === 'left' ? axisWidthShrinkTimerLeft : axisWidthShrinkTimerRight;
    if (timer === null) {
      const pendingValue = target;
      if (axis === 'left') {
        pendingShrinkWidthLeft = pendingValue;
        axisWidthShrinkTimerLeft = window.setTimeout(() => {
          // Shrink is applied on next layout calculation
          if (pendingShrinkWidthLeft !== null) {
            cachedAxisWidthLeft = pendingShrinkWidthLeft;
            pendingShrinkWidthLeft = null;
            invalidate(InvalidationFlag.Layout);
          }
          axisWidthShrinkTimerLeft = null;
        }, AXIS_WIDTH_SHRINK_DELAY_MS);
      } else {
        pendingShrinkWidthRight = pendingValue;
        axisWidthShrinkTimerRight = window.setTimeout(() => {
          // Shrink is applied on next layout calculation
          if (pendingShrinkWidthRight !== null) {
            cachedAxisWidthRight = pendingShrinkWidthRight;
            pendingShrinkWidthRight = null;
            invalidate(InvalidationFlag.Layout);
          }
          axisWidthShrinkTimerRight = null;
        }, AXIS_WIDTH_SHRINK_DELAY_MS);
      }
    } else {
      // Update pending shrink if target changes during delay
      if (axis === 'left') {
        pendingShrinkWidthLeft = target;
      } else {
        pendingShrinkWidthRight = target;
      }
    }

    // Keep current width during shrink delay
    return cached;
  };

  // Legacy function kept for backward compatibility
  const resolveAxisWidth = (target: number, cached: number): number => {
    if (!Number.isFinite(target) || target <= 0) return 0;
    if (!Number.isFinite(cached) || cached <= 0) return target;
    const lower = cached * (1 - AXIS_WIDTH_HYSTERESIS_RATIO);
    const upper = cached * (1 + AXIS_WIDTH_HYSTERESIS_RATIO);
    if (target >= lower && target <= upper) {
      return cached;
    }
    return target;
  };

  const resolveAxisLabelSpacing = (fontSizePx: number): number => {
    const desired = Math.max(
      MIN_AXIS_LABEL_SPACING,
      Math.round(fontSizePx * AXIS_LABEL_SPACING_RATIO),
    );
    if (cachedAxisLabelSpacing <= 0) {
      cachedAxisLabelSpacing = desired;
      return desired;
    }
    const lower = cachedAxisLabelSpacing * (1 - AXIS_WIDTH_HYSTERESIS_RATIO);
    const upper = cachedAxisLabelSpacing * (1 + AXIS_WIDTH_HYSTERESIS_RATIO);
    if (desired >= lower && desired <= upper) {
      return cachedAxisLabelSpacing;
    }
    cachedAxisLabelSpacing = desired;
    return desired;
  };

  const buildTickOverscanRange = (range: VisibleTimeRange): VisibleTimeRange => {
    if (panOverscanRatio <= 0) return { ...range };
    const span = range.to - range.from;
    if (!Number.isFinite(span) || span <= 0) return { ...range };
    return normalizeRange({
      from: range.from - span * panOverscanRatio,
      to: range.to + span * panOverscanRatio,
    });
  };

  const resolveTimeTicks = (
    range: VisibleTimeRange,
    desiredCount: number,
    allowReuse: boolean,
  ): number[] => {
    if (
      allowReuse &&
      cachedTimeTicks &&
      cachedTimeTicks.count === desiredCount &&
      rangeContains(cachedTimeTicks.range, range)
    ) {
      return cachedTimeTicks.ticks;
    }
    const tickRange = allowReuse ? buildTickOverscanRange(range) : range;
    const ticks = xScale.getTicksForRange(tickRange, desiredCount);
    cachedTimeTicks = { range: tickRange, ticks, count: desiredCount };
    return ticks;
  };

  const filterAxisLabels = (
    labels: AxisLabel[],
    axisRect: Rect | null,
    entireTextOnly: boolean,
    minSpacing: number,
  ): AxisLabel[] => {
    if (!axisRect) return labels;
    let filtered = labels;
    if (entireTextOnly) {
      const halfHeight = paint.fontSizePx * 0.5;
      const minY = axisRect.y + halfHeight;
      const maxY = axisRect.y + axisRect.height - halfHeight;
      filtered = filtered.filter((label) => label.y >= minY && label.y <= maxY);
    }
    if (filtered.length <= 2 || !Number.isFinite(minSpacing) || minSpacing <= 0) {
      return filtered;
    }
    const sorted = [...filtered].sort((a, b) => a.y - b.y);
    const result: AxisLabel[] = [];
    let lastY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < sorted.length; i += 1) {
      const label = sorted[i]!;
      if (i === 0) {
        result.push(label);
        lastY = label.y;
        continue;
      }
      if (i === sorted.length - 1) {
        if (label.y - lastY < minSpacing && result.length > 0) {
          result[result.length - 1] = label;
        } else {
          result.push(label);
        }
        continue;
      }
      if (label.y - lastY < minSpacing) {
        continue;
      }
      result.push(label);
      lastY = label.y;
    }
    return result;
  };

  const filterTimeLabels = (
    labels: TimeLabel[],
    axisRect: Rect | null,
    minSpacing: number,
  ): TimeLabel[] => {
    if (!axisRect || labels.length <= 1) return labels;
    const halfWidth = (labels[0]?.width ?? 0) * 0.5;
    const minX = axisRect.x + halfWidth;
    const maxX = axisRect.x + axisRect.width - halfWidth;
    let filtered = labels.filter((label) => label.x >= minX && label.x <= maxX);
    if (filtered.length <= 2 || !Number.isFinite(minSpacing) || minSpacing <= 0) {
      return filtered;
    }
    const sorted = [...filtered].sort((a, b) => a.x - b.x);
    const result: TimeLabel[] = [];
    let lastX = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < sorted.length; i += 1) {
      const label = sorted[i]!;
      const spacing = label.width + paint.axisPadding * 2;
      if (i === 0) {
        result.push(label);
        lastX = label.x;
        continue;
      }
      if (i === sorted.length - 1) {
        if (label.x - lastX < spacing && result.length > 0) {
          result[result.length - 1] = label;
        } else {
          result.push(label);
        }
        continue;
      }
      if (label.x - lastX < spacing) {
        continue;
      }
      result.push(label);
      lastX = label.x;
    }
    return result;
  };

  const resolveVisiblePanes = (): InternalPane[] => {
    const panes = paneList
      .filter((pane) => pane.id === defaultPaneId || pane.visible)
      .filter((pane) => pane.preserveEmpty || hasVisibleSeries(pane.id));
    if (panes.length === 0) return [defaultPane];
    return panes;
  };

  const resolveMinPaneHeight = (totalHeight: number, paneCount: number): number => {
    if (!Number.isFinite(totalHeight) || totalHeight <= 0 || paneCount <= 0) return 1;
    const maxAllowed = Math.max(1, Math.floor(totalHeight / paneCount));
    return Math.max(1, Math.min(paneMinHeightPx, maxAllowed));
  };

  const resolvePaneHeights = (panes: InternalPane[], totalHeight: number): number[] => {
    const paneCount = panes.length;
    if (paneCount === 0) return [];
    const minHeight = resolveMinPaneHeight(totalHeight, paneCount);
    const heights = new Array<number>(paneCount).fill(0);
    const fixedIndices: number[] = [];
    const flexIndices: number[] = [];
    let fixedTotal = 0;

    for (let i = 0; i < paneCount; i += 1) {
      const pane = panes[i]!;
      if (pane.fixedHeight !== null) {
        const height = Math.max(minHeight, Math.round(pane.fixedHeight));
        heights[i] = height;
        fixedIndices.push(i);
        fixedTotal += height;
      } else {
        flexIndices.push(i);
      }
    }

    if (flexIndices.length === 0) {
      const scale = fixedTotal > 0 ? totalHeight / fixedTotal : 1;
      let scaledTotal = 0;
      for (const idx of fixedIndices) {
        const base = heights[idx] ?? minHeight;
        const height = Math.max(minHeight, Math.floor(base * scale));
        heights[idx] = height;
        scaledTotal += height;
      }
      let delta = Math.round(totalHeight - scaledTotal);
      for (let i = 0; delta !== 0 && i < heights.length; i += 1) {
        const idx = i % heights.length;
        const next = heights[idx] ?? minHeight;
        const adjusted = next + (delta > 0 ? 1 : -1);
        if (adjusted >= minHeight) {
          heights[idx] = adjusted;
          delta += delta > 0 ? -1 : 1;
        }
      }
      return heights;
    }

    let remaining = totalHeight - fixedTotal;
    if (remaining < flexIndices.length * minHeight) {
      const availableForFixed = Math.max(0, totalHeight - flexIndices.length * minHeight);
      if (fixedTotal > 0 && availableForFixed < fixedTotal) {
        const scale = availableForFixed / fixedTotal;
        fixedTotal = 0;
        for (const idx of fixedIndices) {
          const base = heights[idx] ?? minHeight;
          const height = Math.max(minHeight, Math.floor(base * scale));
          heights[idx] = height;
          fixedTotal += height;
        }
      }
      remaining = totalHeight - fixedTotal;
    }

    remaining = Math.max(0, remaining);
    let stretchTotal = flexIndices.reduce((sum, idx) => sum + panes[idx]!.stretchFactor, 0);
    if (!Number.isFinite(stretchTotal) || stretchTotal <= 0) {
      stretchTotal = flexIndices.length;
    }

    const fractions: Array<{ idx: number; frac: number }> = [];
    let flexTotal = 0;
    for (const idx of flexIndices) {
      const pane = panes[idx]!;
      const weight = pane.stretchFactor;
      const exact = (remaining * weight) / stretchTotal;
      const base = Math.max(minHeight, Math.floor(exact));
      heights[idx] = base;
      flexTotal += base;
      fractions.push({ idx, frac: exact - Math.floor(exact) });
    }

    let delta = Math.round(totalHeight - (fixedTotal + flexTotal));
    fractions.sort((a, b) => b.frac - a.frac);
    let cursor = 0;
    while (delta !== 0 && fractions.length > 0) {
      const { idx } = fractions[cursor % fractions.length]!;
      const next = heights[idx] ?? minHeight;
      const adjusted = next + (delta > 0 ? 1 : -1);
      if (adjusted >= minHeight) {
        heights[idx] = adjusted;
        delta += delta > 0 ? -1 : 1;
      } else {
        break;
      }
      cursor += 1;
    }

    return heights;
  };

  const drawUnderlay = (
    plotRect: Rect,
    states: PaneState[],
    panOffsetPx = 0,
  ): void => {
    const ctx = underlay.context;
    if (!ctx) return;
    const size = underlay.getSize();
    const font = paint.font;
    const padding = paint.axisPadding;

    // V7: Opaque layer - fill with background color (don't use clearRect - it fills with black!)
    ctx.fillStyle = paint.background;
    ctx.fillRect(0, 0, size.cssWidth, size.cssHeight);

    // Plugin underlay hooks
    const underlayState = buildPluginState(underlay);
    if (underlayState) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      ctx.clip();
      for (const plugin of plugins) {
        plugin.onRenderUnderlay?.(ctx, underlayState);
      }
      ctx.restore();
    }

    renderWatermark(ctx, plotRect);

    // === SIMPLE GRID SYSTEM ===
    // Use axis labels as the source of truth for grid line positions
    // This guarantees grid lines align with axis labels
    for (const paneState of states) {
      const paneRect = paneState.plotRect;

      // Use whichever axis has labels - prefer the one with more labels
      const leftLabels = paneState.axisLabelsLeft || [];
      const rightLabels = paneState.axisLabelsRight || [];
      const axisLabels = leftLabels.length >= rightLabels.length ? leftLabels : rightLabels;

      // Create ticks from axis labels (guaranteed to match Y-axis labels)
      const yTicks: Tick[] = axisLabels.map(label => ({
        value: 0, // Not used for grid rendering
        px: label.y,
        kind: 'major' as const,
        label: label.text,
      }));

      // Generate X-axis ticks using TickCoordinator
      // This ensures grid moves with candlesticks during dragging
      const xTicks = tickCoordinator
        .getXTicks(xScale as TimeScale, plotRect, underlay, false, { panActive: panActive || inertiaActive })
        .filter((t: Tick) => t.kind === 'major' || t.kind === 'edge');
      const gridXTicks =
        panOffsetPx !== 0
          ? xTicks.map((tick) => ({ ...tick, px: tick.px + panOffsetPx }))
          : xTicks;

      // Render grid - lines will align perfectly with axis labels
      // V13: Skip minor grid lines during pan for smoother performance
      renderGridFromTicks(
        ctx,
        paneRect,
        yTicks,
        gridXTicks,
        paint.gridMajor ?? 'rgba(255, 255, 255, 0.08)',
        paint.gridMinor ?? 'rgba(255, 255, 255, 0.03)',
        {
          majorAlpha: 1,
          minorAlpha: 0.65,
          dpr: underlay.getSize().dpr,
          skipMinors: panActive || inertiaActive, // V13: Skip minors during pan/inertia
        }
      );
    }

    // Render Y-axis labels
    for (let index = 0; index < states.length; index += 1) {
      const paneState = states[index]!;

      if (paneState.leftAxisRect && paneState.axisUsage.left) {
        renderYAxis(ctx, paneState.leftAxisRect, paneState.axisLabelsLeft, {
          font,
          color: paint.axisText,
          padding,
          align: 'left',
        });
        axisLabelDrawCount += paneState.axisLabelsLeft.length;
      }
      if (paneState.rightAxisRect && paneState.axisUsage.right) {
        renderYAxis(ctx, paneState.rightAxisRect, paneState.axisLabelsRight, {
          font,
          color: paint.axisText,
          padding,
          align: 'right',
        });
        axisLabelDrawCount += paneState.axisLabelsRight.length;
      }
    }

    // Render time axis labels
    if (layoutState && layoutState.timeAxisRect) {
      const timeLabelsToDraw =
        panOffsetPx !== 0
          ? timeLabels.map((label) => ({ ...label, x: label.x + panOffsetPx }))
          : timeLabels;
      renderXAxis(ctx, layoutState.timeAxisRect, timeLabelsToDraw, {
        font,
        color: paint.axisText,
        padding,
      });
      axisLabelDrawCount += timeLabelsToDraw.length;
    }
  };

  const renderLayout = () => {
    const ctx = underlay.context;
    if (!ctx) return;
    const size = underlay.getSize();
    const font = paint.font;
    const padding = paint.axisPadding;
    const axisLabelSpacing = resolveAxisLabelSpacing(paint.fontSizePx);
    const interactionActive = isInteractionActive();
    const skipMinorGrid = interactionActive && renderQualityLevel >= 1;
    const reduceAxisMeasure =
      interactionActive && (renderQualityLevel >= 2 || panActive || inertiaActive);
    const canReuseAxisWidthLeft = reduceAxisMeasure && cachedAxisWidthLeft > 0;
    const canReuseAxisWidthRight = reduceAxisMeasure && cachedAxisWidthRight > 0;
    const cachedLeftLabelWidth = canReuseAxisWidthLeft
      ? Math.max(0, cachedAxisWidthLeft - padding * 2)
      : 0;
    const cachedRightLabelWidth = canReuseAxisWidthRight
      ? Math.max(0, cachedAxisWidthRight - padding * 2)
      : 0;
    const measureLabel = (text: string): number => {
      axisLabelMeasureCount += 1;
      return labelCache.measure(ctx, font, text);
    };

    const range = xScale.getVisibleRange();
    const { clamped: axisRange, elasticActive } = resolveElasticRange(range);
    const resolvedRange = elasticMode === 'pan' && elasticActive ? axisRange : range;
    const visiblePanes = resolveVisiblePanes();
    const paneMetrics = visiblePanes.map((pane) => {
      const axisUsage = {
        left: hasAxisSeries(pane.id, 'left'),
        right: hasAxisSeries(pane.id, 'right'),
      };
      const primaryAxis: AxisId = axisUsage.left || !axisUsage.right ? 'left' : 'right';
      updateAxisScales(pane, resolvedRange);
      const leftOptions = pane.leftScale.getOptions();
      const rightOptions = pane.rightScale.getOptions();
      const leftTicksVisible = axisUsage.left && (leftOptions.ticksVisible ?? true);
      const rightTicksVisible = axisUsage.right && (rightOptions.ticksVisible ?? true);

      // Generate ticks using TickCoordinator (unified system with smart caching)
      // Use container size for default height (will be updated in renderLayout with actual pane height)
      const containerSize = underlay.getSize();
      const defaultPaneHeight = layoutState?.panes?.find(p => p.id === pane.id)?.plotRect.height ?? containerSize.cssHeight;
      const paneRect = { x: 0, y: 0, width: 1, height: defaultPaneHeight > 1 ? defaultPaneHeight : containerSize.cssHeight };

      // Always generate ticks for grid - even if no series attached yet
      // This ensures grid lines are drawn from the start
      const leftTicks: Tick[] = useUnifiedTickSystem
        ? tickCoordinator.getYTicks(
          pane.id,
          pane.leftScale,
          paneRect,
          underlay,
          skipMinorGrid,
          {
            targetMajorPx: 80,
            minMajorPx: 50,
            maxMajorPx: 120,
            minMinorPx: 12,
            tickSize: leftOptions.priceFormat?.minMove ?? 0,
            useFinancialNice: true,
            axis: 'left',
            panActive: panActive || inertiaActive,
          }
        )
        : pane.leftScale.getTicks().map((v): Tick => ({
          value: v,
          px: underlay.snapY(paneRect.y + pane.leftScale.valueToY(v)),
          kind: 'major',
          label: pane.leftScale.format(v),
        }));

      const rightTicks: Tick[] = useUnifiedTickSystem
        ? tickCoordinator.getYTicks(
          pane.id,
          pane.rightScale,
          paneRect,
          underlay,
          skipMinorGrid,
          {
            targetMajorPx: 80,
            minMajorPx: 50,
            maxMajorPx: 120,
            minMinorPx: 12,
            tickSize: rightOptions.priceFormat?.minMove ?? 0,
            useFinancialNice: true,
            axis: 'right',
            panActive: panActive || inertiaActive,
          }
        )
        : pane.rightScale.getTicks().map((v): Tick => ({
          value: v,
          px: underlay.snapY(paneRect.y + pane.rightScale.valueToY(v)),
          kind: 'major',
          label: pane.rightScale.format(v),
        }));

      const leftMaxWidth = leftTicksVisible
        ? leftTicks
          .filter(t => t.kind === 'major' || t.kind === 'edge')
          .reduce((max, tick) => {
            const text = tick.label ?? pane.leftScale.format(tick.value);
            if (canReuseAxisWidthLeft) {
              return Math.max(max, cachedLeftLabelWidth);
            }
            return Math.max(max, measureLabel(text));
          }, 0)
        : 0;
      const rightMaxWidth = rightTicksVisible
        ? rightTicks
          .filter(t => t.kind === 'major' || t.kind === 'edge')
          .reduce((max, tick) => {
            const text = tick.label ?? pane.rightScale.format(tick.value);
            if (canReuseAxisWidthRight) {
              return Math.max(max, cachedRightLabelWidth);
            }
            return Math.max(max, measureLabel(text));
          }, 0)
        : 0;
      const leftMinWidth = axisUsage.left ? Math.max(0, leftOptions.minWidth ?? 0) : 0;
      const rightMinWidth = axisUsage.right ? Math.max(0, rightOptions.minWidth ?? 0) : 0;

      // Ticks are now managed by TickCoordinator - no need to store separately

      return {
        pane,
        axisUsage,
        primaryAxis,
        leftTicks,
        rightTicks,
        leftTicksVisible,
        rightTicksVisible,
        leftMaxWidth,
        rightMaxWidth,
        leftMinWidth,
        rightMinWidth,
        leftEntireTextOnly: leftOptions.entireTextOnly ?? false,
        rightEntireTextOnly: rightOptions.entireTextOnly ?? false,
        leftBorderVisible: leftOptions.borderVisible ?? false,
        rightBorderVisible: rightOptions.borderVisible ?? false,
      };
    });

    const maxLeftWidth = paneMetrics.reduce((max, metric) => Math.max(max, metric.leftMaxWidth), 0);
    const maxRightWidth = paneMetrics.reduce((max, metric) => Math.max(max, metric.rightMaxWidth), 0);
    const maxLeftMinWidth = paneMetrics.reduce((max, metric) => Math.max(max, metric.leftMinWidth), 0);
    const maxRightMinWidth = paneMetrics.reduce((max, metric) => Math.max(max, metric.rightMinWidth), 0);
    const hasLeftAxis = paneMetrics.some((metric) => metric.axisUsage.left);
    const hasRightAxis = paneMetrics.some((metric) => metric.axisUsage.right);
    let leftAxisWidth =
      maxLeftWidth > 0 ? Math.ceil(Math.max(maxLeftWidth, axisPillWidthLeft) + padding * 2) : 0;
    let rightAxisWidth =
      maxRightWidth > 0 ? Math.ceil(Math.max(maxRightWidth, axisPillWidthRight) + padding * 2) : 0;

    if (hasLeftAxis && maxLeftMinWidth > 0) {
      leftAxisWidth = Math.max(leftAxisWidth, Math.ceil(maxLeftMinWidth));
    }
    if (hasRightAxis && maxRightMinWidth > 0) {
      rightAxisWidth = Math.max(rightAxisWidth, Math.ceil(maxRightMinWidth));
    }

    if (interactionActive) {
      if (cachedAxisWidthLeft > 0) {
        leftAxisWidth = Math.max(leftAxisWidth, cachedAxisWidthLeft);
      }
      if (cachedAxisWidthRight > 0) {
        rightAxisWidth = Math.max(rightAxisWidth, cachedAxisWidthRight);
      }
    }
    // V7: Enhanced axis width hysteresis with shrink delay and threshold
    leftAxisWidth = resolveAxisWidthWithHysteresis(leftAxisWidth, cachedAxisWidthLeft, 'left');
    rightAxisWidth = resolveAxisWidthWithHysteresis(rightAxisWidth, cachedAxisWidthRight, 'right');

    // Update cached widths immediately on expand (shrink handled by timer)
    if (!interactionActive || leftAxisWidth > cachedAxisWidthLeft) {
      cachedAxisWidthLeft = leftAxisWidth;
    }
    if (!interactionActive || rightAxisWidth > cachedAxisWidthRight) {
      cachedAxisWidthRight = rightAxisWidth;
    }

    // Apply pending shrink if timer has fired (checked each frame)
    if (pendingShrinkWidthLeft !== null && axisWidthShrinkTimerLeft === null) {
      cachedAxisWidthLeft = pendingShrinkWidthLeft;
      pendingShrinkWidthLeft = null;
    }
    if (pendingShrinkWidthRight !== null && axisWidthShrinkTimerRight === null) {
      cachedAxisWidthRight = pendingShrinkWidthRight;
      pendingShrinkWidthRight = null;
    }

    const layout = layoutEngine.compute({
      width: size.cssWidth,
      height: size.cssHeight,
      leftAxisWidth,
      rightAxisWidth,
      bottomAxisHeight: TIME_AXIS_HEIGHT_PX,
    });
    const plotRect = layout.plotRect;
    xScale.setPlotWidth(plotRect.width);
    applyResizeTimeScaleAdjust(plotRect.width);

    const paneRects: Rect[] = [];
    paneHeightsById.clear();
    if (visiblePanes.length > 0) {
      const heights = resolvePaneHeights(visiblePanes, plotRect.height);
      let lastY = plotRect.y;
      for (let i = 0; i < visiblePanes.length; i += 1) {
        const pane = visiblePanes[i]!;
        const height =
          i === visiblePanes.length - 1
            ? Math.max(1, plotRect.y + plotRect.height - lastY)
            : Math.max(1, Math.round(heights[i] ?? 0));
        paneRects.push({ x: plotRect.x, y: lastY, width: plotRect.width, height });
        paneHeightsById.set(pane.id, height);
        lastY += height;
      }
    }

    paneStates = [];
    paneStateById.clear();
    const paneLayouts: NonNullable<LayoutResult['panes']> = [];

    const maxTimeLabelWidth = resolveTimeLabelWidth(
      resolvedRange,
      measureLabel,
      !reduceAxisMeasure,
    );
    const minTickSpacing = Math.max(MIN_TIME_TICK_SPACING, maxTimeLabelWidth + padding * 2);
    const xTickCount = clamp(
      Math.floor(plotRect.width / minTickSpacing) + 1,
      2,
      MAX_TIME_TICKS,
    );

    // Generate X-axis ticks using TickCoordinator
    // This ensures tick times/dates update during pan, while hysteresis prevents step jitter during zoom
    const xTicks = tickCoordinator.getXTicks(
      xScale as TimeScale,
      plotRect,
      underlay,
      skipMinorGrid,
      { panActive: panActive || inertiaActive }
    );

    if (xTicks.length === 0) {
      // Fallback for custom scales without generateTicks
      const tickTimes = xScale.getTicksForRange(resolvedRange, xTickCount);
      for (const time of tickTimes) {
        const x = plotRect.x + xScale.timeToX(time);
        if (!Number.isFinite(x)) continue;
        if (x < plotRect.x - 0.5 || x > plotRect.x + plotRect.width + 0.5) continue;
        xTicks.push({
          value: time,
          px: underlay.snapX(x),
          kind: 'major',
          label: formatTime(time),
        });
      }
    }

    // Separate major and minor ticks for grid rendering
    const xTicksMajor = xTicks.filter(t => t.kind === 'major' || t.kind === 'edge');
    const xTicksMinor = xTicks.filter(t => t.kind === 'minor');

    // Extract time labels from major ticks only
    const rawTimeLabels: TimeLabel[] = xTicksMajor.map(tick => ({
      text: tick.label ?? formatTime(tick.value),
      x: tick.px,
      width: maxTimeLabelWidth,
    }));
    timeLabels = filterTimeLabels(rawTimeLabels, layout.timeAxisRect, maxTimeLabelWidth + padding * 2);

    // Store ticks for grid rendering (when re-implemented)
    // cachedXTicksMajor = xTicksMajor;
    // cachedXTicksMinor = xTicksMinor;

    // Clear grid cache and tick coordinator on layout change
    clearGridCache();
    tickCoordinator.invalidateAll();

    paneMetrics.forEach((metric, index) => {
      const paneRect = paneRects[index] ?? plotRect;
      metric.pane.leftScale.setHeight(paneRect.height);
      metric.pane.rightScale.setHeight(paneRect.height);

      const leftAxisRect =
        leftAxisWidth > 0 ? { x: 0, y: paneRect.y, width: leftAxisWidth, height: paneRect.height } : null;
      const rightAxisRect =
        rightAxisWidth > 0
          ? { x: plotRect.x + plotRect.width, y: paneRect.y, width: rightAxisWidth, height: paneRect.height }
          : null;

      const rawAxisLabelsLeft = metric.leftTicksVisible
        ? metric.leftTicks
          .filter((t: Tick) => t.kind === 'major' || t.kind === 'edge')
          .map((tick: Tick) => ({
            text: tick.label ?? metric.pane.leftScale.format(tick.value),
            y: underlay.snapY(paneRect.y + metric.pane.leftScale.valueToY(tick.value)),
            width: metric.leftMaxWidth,
          }))
        : [];
      const rawAxisLabelsRight = metric.rightTicksVisible
        ? metric.rightTicks
          .filter((t: Tick) => t.kind === 'major' || t.kind === 'edge')
          .map((tick: Tick) => ({
            text: tick.label ?? metric.pane.rightScale.format(tick.value),
            y: underlay.snapY(paneRect.y + metric.pane.rightScale.valueToY(tick.value)),
            width: metric.rightMaxWidth,
          }))
        : [];
      // Increase spacing for smaller panes to prevent overly dense gridlines
      const paneSpacing = paneRect.height < SMALL_PANE_HEIGHT_THRESHOLD
        ? axisLabelSpacing * SMALL_PANE_SPACING_MULTIPLIER
        : axisLabelSpacing;
      const axisLabelsLeft = filterAxisLabels(
        rawAxisLabelsLeft,
        leftAxisRect,
        metric.leftEntireTextOnly,
        paneSpacing,
      );
      const axisLabelsRight = filterAxisLabels(
        rawAxisLabelsRight,
        rightAxisRect,
        metric.rightEntireTextOnly,
        paneSpacing,
      );

      const gridTicks = metric.primaryAxis === 'right' ? metric.rightTicks : metric.leftTicks;
      const gridScale = metric.primaryAxis === 'right' ? metric.pane.rightScale : metric.pane.leftScale;
      const gridY = gridTicks
        .filter((t: Tick) => t.kind === 'major')
        .map((tick: Tick) => underlay.snapY(paneRect.y + gridScale.valueToY(tick.value)));

      const paneState: PaneState = {
        id: metric.pane.id,
        plotRect: paneRect,
        leftAxisRect,
        rightAxisRect,
        axisUsage: metric.axisUsage,
        primaryAxis: metric.primaryAxis,
        axisLabelsLeft,
        axisLabelsRight,
        leftBorderVisible: metric.leftBorderVisible,
        rightBorderVisible: metric.rightBorderVisible,
      };
      paneStates.push(paneState);
      paneStateById.set(metric.pane.id, paneState);
      paneLayouts.push({
        id: metric.pane.id,
        plotRect: { ...paneRect },
        leftAxisRect: leftAxisRect ? { ...leftAxisRect } : null,
        rightAxisRect: rightAxisRect ? { ...rightAxisRect } : null,
      });
    });

    layoutState = { ...layout, panes: paneLayouts };
    if (externalCrosshair) {
      applyExternalCrosshair(externalCrosshair, false);
    } else if (pendingExternalCrosshair) {
      applyExternalCrosshair(pendingExternalCrosshair, false);
    }

    drawUnderlay(plotRect, paneStates, panOverscrollPx);
  };

  const renderUnderlay = () => {
    const ctx = underlay.context;
    if (!ctx) return;
    if (!layoutState) {
      renderLayout();
      return;
    }
    const size = underlay.getSize();
    const font = paint.font;
    const padding = paint.axisPadding;
    const axisLabelSpacing = resolveAxisLabelSpacing(paint.fontSizePx);
    const interactionActive = isInteractionActive();
    const skipMinorGrid = interactionActive && renderQualityLevel >= 1;
    const reduceAxisMeasure =
      interactionActive && (renderQualityLevel >= 2 || panActive || inertiaActive);
    const canReuseAxisWidthLeft = reduceAxisMeasure && cachedAxisWidthLeft > 0;
    const canReuseAxisWidthRight = reduceAxisMeasure && cachedAxisWidthRight > 0;
    const cachedLeftLabelWidth = canReuseAxisWidthLeft
      ? Math.max(0, cachedAxisWidthLeft - padding * 2)
      : 0;
    const cachedRightLabelWidth = canReuseAxisWidthRight
      ? Math.max(0, cachedAxisWidthRight - padding * 2)
      : 0;
    const measureLabel = (text: string): number => {
      axisLabelMeasureCount += 1;
      return labelCache.measure(ctx, font, text);
    };

    const plotRect = layoutState.plotRect;
    const range = xScale.getVisibleRange();
    const { clamped: axisRange, elasticActive } = resolveElasticRange(range);
    const resolvedRange = elasticMode === 'pan' && elasticActive ? axisRange : range;

    const maxTimeLabelWidth = resolveTimeLabelWidth(
      resolvedRange,
      measureLabel,
      !reduceAxisMeasure,
    );
    const minTickSpacing = Math.max(MIN_TIME_TICK_SPACING, maxTimeLabelWidth + padding * 2);
    const xTickCount = clamp(
      Math.floor(plotRect.width / minTickSpacing) + 1,
      2,
      MAX_TIME_TICKS,
    );

    // Generate X-axis ticks using TickCoordinator
    // This ensures X-axis labels update DURING drag, not just after release
    const xTicks = tickCoordinator.getXTicks(
      xScale as TimeScale,
      plotRect,
      underlay,
      skipMinorGrid,
      { panActive: panActive || inertiaActive }
    );

    // Extract time labels from generated xTicks
    const rawTimeLabels: TimeLabel[] = xTicks
      .filter((t: Tick) => (t.kind === 'major' || t.kind === 'edge') && t.label)
      .map((tick: Tick) => ({
        text: tick.label!,
        x: tick.px,
        width: maxTimeLabelWidth,
      }));
    timeLabels = filterTimeLabels(rawTimeLabels, layoutState.timeAxisRect, maxTimeLabelWidth + padding * 2);

    paneStates = [];
    paneStateById.clear();
    const paneLayouts = layoutState.panes ?? [];
    let maxLeftWidth = 0;
    let maxRightWidth = 0;

    for (const paneLayout of paneLayouts) {
      const pane = paneById.get(paneLayout.id);
      if (!pane) continue;
      const paneRect = paneLayout.plotRect;
      pane.leftScale.setHeight(paneRect.height);
      pane.rightScale.setHeight(paneRect.height);

      const axisUsage = {
        left: hasAxisSeries(pane.id, 'left'),
        right: hasAxisSeries(pane.id, 'right'),
      };
      const primaryAxis: AxisId = axisUsage.left || !axisUsage.right ? 'left' : 'right';
      updateAxisScales(pane, resolvedRange);
      const leftOptions = pane.leftScale.getOptions();
      const rightOptions = pane.rightScale.getOptions();
      const leftTicksVisible = axisUsage.left && (leftOptions.ticksVisible ?? true);
      const rightTicksVisible = axisUsage.right && (rightOptions.ticksVisible ?? true);

      // Generate ticks using TickCoordinator (unified system)
      // Always generate ticks for grid even if no series attached (uses current scale range)
      const leftTicks: Tick[] = useUnifiedTickSystem
        ? tickCoordinator.getYTicks(
          pane.id,
          pane.leftScale,
          paneRect,
          underlay,
          skipMinorGrid,
          {
            targetMajorPx: 80,
            minMajorPx: 50,
            maxMajorPx: 120,
            minMinorPx: 12,
            tickSize: leftOptions.priceFormat?.minMove ?? 0,
            useFinancialNice: true,
            axis: 'left',
            panActive: panActive || inertiaActive,
          }
        )
        : pane.leftScale.getTicks().map((v): Tick => ({
          value: v,
          px: underlay.snapY(paneRect.y + pane.leftScale.valueToY(v)),
          kind: 'major',
          label: pane.leftScale.format(v),
        }));

      const rightTicks: Tick[] = useUnifiedTickSystem
        ? tickCoordinator.getYTicks(
          pane.id,
          pane.rightScale,
          paneRect,
          underlay,
          skipMinorGrid,
          {
            targetMajorPx: 80,
            minMajorPx: 50,
            maxMajorPx: 120,
            minMinorPx: 12,
            tickSize: rightOptions.priceFormat?.minMove ?? 0,
            useFinancialNice: true,
            axis: 'right',
            panActive: panActive || inertiaActive,
          }
        )
        : pane.rightScale.getTicks().map((v): Tick => ({
          value: v,
          px: underlay.snapY(paneRect.y + pane.rightScale.valueToY(v)),
          kind: 'major',
          label: pane.rightScale.format(v),
        }));

      const leftMaxWidth = leftTicksVisible
        ? leftTicks
          .filter(t => t.kind === 'major' || t.kind === 'edge')
          .reduce((max, tick) => {
            const text = tick.label ?? pane.leftScale.format(tick.value);
            if (canReuseAxisWidthLeft) {
              return Math.max(max, cachedLeftLabelWidth);
            }
            return Math.max(max, measureLabel(text));
          }, 0)
        : 0;
      const rightMaxWidth = rightTicksVisible
        ? rightTicks
          .filter(t => t.kind === 'major' || t.kind === 'edge')
          .reduce((max, tick) => {
            const text = tick.label ?? pane.rightScale.format(tick.value);
            if (canReuseAxisWidthRight) {
              return Math.max(max, cachedRightLabelWidth);
            }
            return Math.max(max, measureLabel(text));
          }, 0)
        : 0;
      maxLeftWidth = Math.max(maxLeftWidth, leftMaxWidth);
      maxRightWidth = Math.max(maxRightWidth, rightMaxWidth);

      // UNIFIED: Y-axis labels use pre-snapped tick.px values
      // NO recalculation, NO re-snapping - guaranteed alignment with grid
      const rawAxisLabelsLeft = paneLayout.leftAxisRect && leftTicksVisible
        ? leftTicks
          .filter((t: Tick) => t.kind === 'major' || t.kind === 'edge')
          .map((tick: Tick) => ({
            text: tick.label ?? pane.leftScale.format(tick.value),
            y: tick.px,  // Use pre-snapped pixel position from tick generation
            width: leftMaxWidth,
          }))
        : [];
      const rawAxisLabelsRight = paneLayout.rightAxisRect && rightTicksVisible
        ? rightTicks
          .filter((t: Tick) => t.kind === 'major' || t.kind === 'edge')
          .map((tick: Tick) => ({
            text: tick.label ?? pane.rightScale.format(tick.value),
            y: tick.px,  // Use pre-snapped pixel position from tick generation
            width: rightMaxWidth,
          }))
        : [];
      // Increase spacing for smaller panes to prevent overly dense gridlines
      const paneSpacing = paneRect.height < SMALL_PANE_HEIGHT_THRESHOLD
        ? axisLabelSpacing * SMALL_PANE_SPACING_MULTIPLIER
        : axisLabelSpacing;
      const axisLabelsLeft = filterAxisLabels(
        rawAxisLabelsLeft,
        paneLayout.leftAxisRect ?? null,
        leftOptions.entireTextOnly ?? false,
        paneSpacing,
      );
      const axisLabelsRight = filterAxisLabels(
        rawAxisLabelsRight,
        paneLayout.rightAxisRect ?? null,
        rightOptions.entireTextOnly ?? false,
        paneSpacing,
      );

      // Ticks are now managed by TickCoordinator - no need to cache separately

      const paneState: PaneState = {
        id: pane.id,
        plotRect: paneRect,
        leftAxisRect: paneLayout.leftAxisRect ? { ...paneLayout.leftAxisRect } : null,
        rightAxisRect: paneLayout.rightAxisRect ? { ...paneLayout.rightAxisRect } : null,
        axisUsage,
        primaryAxis,
        axisLabelsLeft,
        axisLabelsRight,
        leftBorderVisible: leftOptions.borderVisible ?? false,
        rightBorderVisible: rightOptions.borderVisible ?? false,
      };
      paneStates.push(paneState);
      paneStateById.set(pane.id, paneState);
    }

    if (!reduceAxisMeasure) {
      const leftOverflow = maxLeftWidth + padding * 2 > cachedAxisWidthLeft + 0.5;
      const rightOverflow = maxRightWidth + padding * 2 > cachedAxisWidthRight + 0.5;
      if (leftOverflow || rightOverflow) {
        invalidate(InvalidationFlag.Layout);
      }
    }

    drawUnderlay(plotRect, paneStates, panOverscrollPx);
  };

  const scalesMatch = (a: SeriesWorkerScale, b: SeriesWorkerScale): boolean =>
    a.type === b.type &&
    a.min === b.min &&
    a.max === b.max &&
    a.minPositive === b.minPositive &&
    a.height === b.height;

  const resolveAxisMaxVisibleCounts = (
    seriesGroup: InternalSeries[],
    range: VisibleTimeRange,
  ): Record<AxisId, number> => {
    const maxByAxis: Record<AxisId, number> = { left: 0, right: 0 };
    for (const series of seriesGroup) {
      if (!series.visible || series.data.length === 0) continue;
      const store = series.data;
      const visibleCount = store.upperBound(range.to) - store.lowerBound(range.from);
      if (visibleCount > maxByAxis[series.axis]) {
        maxByAxis[series.axis] = visibleCount;
      }
    }
    return maxByAxis;
  };

  const resolveOhlcBarWidth = (
    range: VisibleTimeRange,
    plotWidth: number,
    series: InternalSeries,
    pointCount: number,
    ratio: number,
    dpr: number,
  ): number => {
    const span = range.to - range.from;

    if (!Number.isFinite(span) || span <= 0) {
      return Math.max(1 / dpr, plotWidth);
    }
    const stepMs =
      Number.isFinite(series.timeStepMs) && (series.timeStepMs ?? 0) > 0
        ? series.timeStepMs!
        : resolveSeriesStepMs();

    if (!stepMs || !Number.isFinite(stepMs) || stepMs <= 0) {
      return Math.max(1 / dpr, plotWidth);
    }

    const nominalSpacing = (stepMs / span) * plotWidth;
    const averageSpacing = plotWidth / Math.max(1, pointCount);
    const spacingPx = Math.min(nominalSpacing, averageSpacing);

    const rawWidth = spacingPx * ratio;
    const minWidth = 1 / dpr;
    return Math.max(minWidth, Math.min(plotWidth, rawWidth));
  };

  const buildPathCacheKey = (
    series: InternalSeries,
    range: VisibleTimeRange,
    plotRect: Rect,
    scale: PriceScale,
    scaleMode: PriceScaleMode,
    scaleBase: number | null,
    scaleType: 'linear' | 'log',
    renderMode: 'linear' | 'step',
    gap: number | null,
    dpr: number,
    sourceKey: string,
    alignedLineWidth: number,
    pointCount: number,
  ): string => {
    const scaleRange = scale.getRange();
    const minPositive = scale.getMinPositive();
    const gapKey = gap ?? 0;
    const baseKey = Number.isFinite(scaleBase) ? scaleBase : 'none';
    return `${series.id}|${series.renderRevision}|${sourceKey}|${range.from}|${range.to}|${plotRect.x}|${plotRect.y}|${plotRect.width}|${plotRect.height}|${scaleMode}|${baseKey}|${scaleType}|${scaleRange.min}|${scaleRange.max}|${minPositive}|${renderMode}|${gapKey}|${alignedLineWidth}|${dpr}|${pointCount}`;
  };

  const renderSeriesToContext = (
    ctx: CanvasRenderingContext2D,
    surface: SnapSurface,
    plotRect: Rect,
    range: VisibleTimeRange,
    seriesGroup: InternalSeries[],
    lastValueRange: VisibleTimeRange = range,
    surfaceDpr?: number,
    xOffset = 0,
    barWidthPlotWidth?: number, // V8 Fix: visible plot width for bar width calculation
    barWidthRangeOverride?: VisibleTimeRange, // V8 Fix: visible range for bar width calculation
  ): void => {
    // GUARD: Skip rendering if range is collapsed/invalid (fixes chart drag bug)
    const rangeSpan = range.to - range.from;
    if (!Number.isFinite(rangeSpan) || rangeSpan <= 0) {
      console.warn('[Chart] renderSeriesToContext: Invalid range, skipping render', {
        from: range.from,
        to: range.to,
        span: rangeSpan,
      });
      return;
    }

    const resolvedDpr =
      surface instanceof CanvasSurface
        ? surface.getSize().dpr
        : typeof surfaceDpr === 'number' && Number.isFinite(surfaceDpr)
          ? Math.max(1, surfaceDpr)
          : 1;
    const resolveLineColor = (series: InternalSeries): string => {
      if (series.options.color) return series.options.color;
      if (series.lastValueColor) return series.lastValueColor;
      return resolveSeriesColor(series, series.order);
    };
    const resolveAreaFills = (series: InternalSeries, lineColor: string): { top: string; bottom: string } => {
      const options = series.options as AreaSeriesOptions;
      const top = options.topColor ?? applyAlpha(lineColor, 0.35);
      const bottom = options.bottomColor ?? applyAlpha(lineColor, 0.05);
      return { top, bottom };
    };
    const resolveBaselineFills = (
      series: InternalSeries,
      lineColor: string,
    ): { top: string; bottom: string; baseValue: number } => {
      const options = series.options as BaselineSeriesOptions;
      const top = options.topColor ?? applyAlpha(lineColor, 0.3);
      const bottom = options.bottomColor ?? applyAlpha(lineColor, 0.15);
      const baseValue = Number.isFinite(options.baseValue) ? options.baseValue! : 0;
      return { top, bottom, baseValue };
    };
    // V8 Fix: Bar width MUST use visible range and visible plot width for consistency
    // During pan cache rendering, plotRect is the cache rect (wider), but bar width
    // should be calculated based on the visible area to match direct rendering
    const barWidthRange = barWidthRangeOverride ?? lastValueRange; // Use explicit override or fallback to lastValueRange
    const barPlotWidth = barWidthPlotWidth ?? plotRect.width; // Use visible plot width when provided

    // V8 Fix: Scale point count by range ratio for cache rendering
    // Cache has more points than visible area, need to scale down to match visible point count
    const coordinateSpan = range.to - range.from;
    const barWidthSpan = barWidthRange.to - barWidthRange.from;
    const pointCountScale = coordinateSpan > 0 && barWidthSpan > 0 ? barWidthSpan / coordinateSpan : 1;

    const resolveHistogramBarWidth = (series: InternalSeries, pointCount: number): number => {
      const span = barWidthRange.to - barWidthRange.from;
      if (!Number.isFinite(span) || span <= 0) {
        return Math.max(1 / resolvedDpr, barPlotWidth);
      }
      const stepMs =
        Number.isFinite(series.timeStepMs) && (series.timeStepMs ?? 0) > 0
          ? series.timeStepMs!
          : resolveSeriesStepMs();

      if (!stepMs || !Number.isFinite(stepMs) || stepMs <= 0) {
        return Math.max(1 / resolvedDpr, barPlotWidth);
      }

      // V8 Fix: Scale pointCount to match visible area
      const visiblePointCount = Math.max(1, Math.round(pointCount * pointCountScale));
      const nominalSpacing = (stepMs / span) * barPlotWidth;
      const averageSpacing = barPlotWidth / Math.max(1, visiblePointCount);
      const spacingPx = Math.min(nominalSpacing, averageSpacing);

      const rawWidth = spacingPx * 0.8;
      const minWidth = 1 / resolvedDpr;
      return Math.max(minWidth, Math.min(barPlotWidth, rawWidth));
    };
    // V8 Fix: Same fix for OHLC (candlestick/bar) width
    const resolveOhlcWidth = (series: InternalSeries, pointCount: number, ratio: number): number => {
      // Scale pointCount to match visible area
      const visiblePointCount = Math.max(1, Math.round(pointCount * pointCountScale));
      return resolveOhlcBarWidth(barWidthRange, barPlotWidth, series, visiblePointCount, ratio, resolvedDpr);
    };
    const timeSpan = range.to - range.from;
    const timeScaleX = timeSpan > 0 ? plotRect.width / timeSpan : 0;
    const timeOriginX = plotRect.x - range.from * timeScaleX + xOffset;

    const renderSeriesByType = (
      series: InternalSeries,
      time: Float64Array,
      value: Float64Array,
      axisScale: PriceScale,
      renderMode: 'linear' | 'step',
      lineWidth: number,
      alignedLineWidth: number,
      canCachePath: boolean,
      pathCacheKey?: string,
    ): void => {
      const pane = paneById.get(series.paneId);
      const isVolume = series.options.isVolume === true;
      const maxVolume = pane?.maxVolume ?? 0;

      const lineColor = resolveLineColor(series);
      if (series.seriesType === 'custom') {
        const renderer = series.customRenderer;
        if (!renderer || time.length === 0 || value.length === 0) return;
        const leftScale = getAxisScale(series.paneId, 'left');
        const rightScale = getAxisScale(series.paneId, 'right');
        const leftBase = getAxisScaleBase(series.paneId, 'left');
        const rightBase = getAxisScaleBase(series.paneId, 'right');
        const axisBase = series.axis === 'right' ? rightBase : leftBase;
        const state = {
          id: series.id,
          paneId: series.paneId,
          axis: series.axis,
          plotRect,
          visibleRange: range,
          data: { time, value, length: time.length },
          timeToX: (t: number) => timeOriginX + t * timeScaleX,
          valueToY: (v: number) => {
            if (isVolume) {
              const volRatio = 0.2;
              const volHeight = plotRect.height * volRatio;
              const volBottom = plotRect.y + plotRect.height;
              return volBottom - (v / (maxVolume || 1)) * volHeight;
            }
            return plotRect.y + axisScale.valueToY(axisScale.toScaleValue(v, axisBase));
          },
          valueToYLeft: (v: number) =>
            plotRect.y + leftScale.valueToY(leftScale.toScaleValue(v, leftBase)),
          valueToYRight: (v: number) =>
            plotRect.y + rightScale.valueToY(rightScale.toScaleValue(v, rightBase)),
          snapX: (x: number, strokeWidth?: number) => surface.snapX(x, strokeWidth),
          snapY: (y: number, strokeWidth?: number) => surface.snapY(y, strokeWidth),
          alignLineWidth: (width: number) => surface.alignLineWidth(width),
          theme,
          options: series.options,
          renderMode,
          gapThresholdMs,
          pixelRatio: resolvedDpr,
        };
        ctx.save();
        ctx.beginPath();
        ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
        ctx.clip();
        renderer.draw(ctx, state);
        ctx.restore();
        return;
      }
      if (series.seriesType === 'histogram') {
        const options = series.options as HistogramSeriesOptions;
        const baseValue = Number.isFinite(options.baseValue) ? options.baseValue! : 0;
        const barWidth = resolveHistogramBarWidth(series, time.length);
        const overrides = histogramColorBySeries.get(series.id);
        const histogramInput: HistogramSeriesRenderInput = {
          ctx,
          surface,
          plotRect,
          xOffset,
          visibleRange: range,
          time,
          value,
          priceScale: axisScale,
          scaleMode: axisScale.getMode(),
          scaleBase: series.scaleBase,
          options,
          defaultColor: lineColor,
          baseValue,
          barWidth,
          dpr: resolvedDpr,
          isVolume,
          maxVolume,
        };
        if (overrides) {
          histogramInput.colorResolver = (timeValue: number, _index: number) =>
            overrides.get(timeValue) ?? null;
        }
        renderHistogramSeries(histogramInput);
        return;
      }
      if (series.seriesType === 'area') {
        const fills = resolveAreaFills(series, lineColor);
        const gradient = ctx.createLinearGradient(0, plotRect.y, 0, plotRect.y + plotRect.height);
        gradient.addColorStop(0, fills.top);
        gradient.addColorStop(1, fills.bottom);
        renderAreaFill({
          ctx,
          surface,
          plotRect,
          xOffset,
          visibleRange: range,
          time,
          value,
          priceScale: axisScale,
          scaleMode: axisScale.getMode(),
          scaleBase: series.scaleBase,
          options: series.options,
          lineWidth,
          renderMode,
          fillStyle: gradient,
          gapThresholdMs,
        });
      } else if (series.seriesType === 'baseline') {
        const fills = resolveBaselineFills(series, lineColor);
        const baselineY = renderBaselineFill({
          ctx,
          surface,
          plotRect,
          xOffset,
          visibleRange: range,
          time,
          value,
          priceScale: axisScale,
          scaleMode: axisScale.getMode(),
          scaleBase: series.scaleBase,
          options: series.options,
          lineWidth,
          renderMode,
          topFill: fills.top,
          bottomFill: fills.bottom,
          baselineValue: fills.baseValue,
          gapThresholdMs,
        });
        if (baselineY !== null) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
          ctx.clip();
          ctx.strokeStyle = applyAlpha(lineColor, 0.55);
          ctx.lineWidth = surface.alignLineWidth(1);
          ctx.setLineDash([]);
          const y = surface.snapY(baselineY, alignedLineWidth);
          ctx.beginPath();
          ctx.moveTo(plotRect.x, y);
          ctx.lineTo(plotRect.x + plotRect.width, y);
          ctx.stroke();
          ctx.restore();
        }
      }
      renderLineSeries({
        ctx,
        surface,
        plotRect,
        xOffset,
        visibleRange: range,
        time,
        value,
        priceScale: axisScale,
        scaleMode: axisScale.getMode(),
        scaleBase: series.scaleBase,
        options: series.options,
        defaultColor: lineColor,
        usePath2D,
        gapThresholdMs,
        ...(canCachePath && pathCacheKey ? { pathCache: linePathCache, pathCacheKey } : {}),
      });
    };
    const maxVisibleCounts = resolveAxisMaxVisibleCounts(seriesGroup, range);
    for (const series of seriesGroup) {
      if (!series.visible) {
        clearSeriesLastValue(series);
        continue;
      }
      applyDirtyRange(series, range);
      if (series.provider) {
        requestProviderRange(series, range);
      }
      const hasOhlc =
        (series.seriesType === 'candlestick' || series.seriesType === 'bar') &&
        !!series.ohlcData &&
        series.ohlcData.length > 0;
      if (series.data.length === 0 && !hasOhlc) {
        clearSeriesLastValue(series);
        continue;
      }
      const axisScale = getAxisScaleForSeries(series);
      const axisScaleType = axisScale.getEffectiveType();
      const renderMode = series.options.renderMode === 'step' ? 'step' : 'linear';
      const lineWidth = Math.max(1, series.options.width ?? 2);
      const alignedLineWidth = surface.alignLineWidth(lineWidth);

      if (isChunkedStore(series.data)) {
        const store = series.data;
        const visibleIndices = {
          from: store.lowerBound(range.from),
          to: store.upperBound(range.to),
        };
        const lastIndices = {
          from: store.lowerBound(lastValueRange.from),
          to: store.upperBound(lastValueRange.to),
        };
        let lastValue: number | null = null;
        for (let i = lastIndices.to - 1; i >= lastIndices.from; i -= 1) {
          const v = store.getValueAt(i);
          if (v !== null && Number.isFinite(v)) {
            lastValue = v;
            break;
          }
        }
        updateSeriesLastValue(series, lastValue, axisScale);

        const rawChunks = store.getChunks();
        pruneChunkLods(series, rawChunks, retainLodOnly);
        const currentFrame = (chunkedLodFrame += 1);
        const activeStarts = new Set<number>();
        let lodUpdated = false;
        for (const chunk of rawChunks) {
          activeStarts.add(chunk.startTime);
          if (chunk.length < lodOptions.minPoints || plotRect.width <= 0) continue;
          if (chunk.endTime < range.from || chunk.startTime > range.to) continue;
          const from = lowerBound(chunk.time, chunk.length, range.from);
          const to = upperBound(chunk.time, chunk.length, range.to);
          const visibleCount = to - from;
          if (visibleCount <= plotRect.width) continue;
          const result = ensureChunkLod(series, chunk, currentFrame);
          if (result.changed) {
            lodUpdated = true;
          }
        }
        const lodOnlyChunks = collectLodOnlyChunks(series, range, activeStarts, currentFrame);
        if (lodUpdated) {
          chunkedDecimator.clearCache();
        }
        const lodEvicted = evictChunkLodsIfNeeded();
        if (lodEvicted) {
          chunkedDecimator.clearCache();
        }

        const chunkInputs = rawChunks.map((chunk) => {
          const base = {
            time: chunk.time,
            value: chunk.value,
            length: chunk.length,
          };
          const entry = series.chunkLods.get(chunk.startTime);
          return {
            startTime: chunk.startTime,
            chunk: entry ? { ...base, lod: entry.lod } : base,
          };
        });
        for (const chunk of lodOnlyChunks) {
          chunkInputs.push({
            startTime: chunk.startTime,
            chunk: {
              time: chunk.time,
              value: chunk.value,
              length: chunk.length,
              lod: chunk.lod,
            },
          });
        }
        chunkInputs.sort((a, b) => a.startTime - b.startTime);
        const chunks = chunkInputs.map((entry) => entry.chunk);

        if (visibleIndices.from >= visibleIndices.to && lodOnlyChunks.length === 0) continue;
        const decimated = chunkedDecimator.decimate({
          seriesId: series.id,
          version: store.version,
          visibleRange: range,
          plotWidth: plotRect.width,
          scaleType: axisScaleType,
          chunks,
        });
        const canCachePath =
          usePath2D &&
          typeof Path2D !== 'undefined' &&
          decimated.time.length <= PATH_CACHE_MAX_POINTS;
        const pathCacheKey = canCachePath
          ? buildPathCacheKey(
            series,
            range,
            plotRect,
            axisScale,
            axisScale.getMode(),
            series.scaleBase,
            axisScaleType,
            renderMode,
            gapThresholdMs,
            resolvedDpr,
            `chunked:${store.version}:${chunks.length}`,
            alignedLineWidth,
            decimated.time.length,
          )
          : undefined;
        renderSeriesByType(
          series,
          decimated.time,
          decimated.value,
          axisScale,
          renderMode,
          lineWidth,
          alignedLineWidth,
          canCachePath,
          pathCacheKey,
        );
        continue;
      }

      const baseTime = series.data.times();
      const baseValue = series.data.values();
      const baseVisible = {
        from: series.data.lowerBound(range.from),
        to: series.data.upperBound(range.to),
      };
      const baseLastVisible = {
        from: series.data.lowerBound(lastValueRange.from),
        to: series.data.upperBound(lastValueRange.to),
      };

      let time = baseTime;
      let value = baseValue;
      let visibleIndices = baseVisible;
      let lastVisibleIndices = baseLastVisible;
      const visibleCount = baseVisible.to - baseVisible.from;
      const axisMaxVisible = maxVisibleCounts[series.axis] || visibleCount;

      const lodLevel = series.lod.pickLevel(axisMaxVisible, plotRect.width);
      if (lodLevel && lodLevel.length > 0) {
        time = lodLevel.time.subarray(0, lodLevel.length);
        value = lodLevel.value.subarray(0, lodLevel.length);
        visibleIndices = {
          from: lowerBound(time, lodLevel.length, range.from),
          to: upperBound(time, lodLevel.length, range.to),
        };
        lastVisibleIndices = {
          from: lowerBound(time, lodLevel.length, lastValueRange.from),
          to: upperBound(time, lodLevel.length, lastValueRange.to),
        };
      }

      let lastValue: number | null = null;
      for (let i = lastVisibleIndices.to - 1; i >= lastVisibleIndices.from; i -= 1) {
        const v = value[i]!;
        if (Number.isFinite(v)) {
          lastValue = v;
          break;
        }
      }
      updateSeriesLastValue(series, lastValue, axisScale);

      if (visibleIndices.from >= visibleIndices.to) continue;

      if (series.seriesType === 'candlestick' || series.seriesType === 'bar') {
        const ohlcStore = series.ohlcData;
        if (ohlcStore && ohlcStore.length > 0) {
          let ohlcTime = ohlcStore.times();
          let ohlcOpen = ohlcStore.opens();
          let ohlcHigh = ohlcStore.highs();
          let ohlcLow = ohlcStore.lows();
          let ohlcClose = ohlcStore.closes();
          let ohlcVisible = {
            from: ohlcStore.lowerBound(range.from),
            to: ohlcStore.upperBound(range.to),
          };
          const ohlcLod = series.ohlcLod?.pickLevel(axisMaxVisible, plotRect.width);
          if (ohlcLod && ohlcLod.length > 0) {
            ohlcTime = ohlcLod.time.subarray(0, ohlcLod.length);
            ohlcOpen = ohlcLod.open.subarray(0, ohlcLod.length);
            ohlcHigh = ohlcLod.high.subarray(0, ohlcLod.length);
            ohlcLow = ohlcLod.low.subarray(0, ohlcLod.length);
            ohlcClose = ohlcLod.close.subarray(0, ohlcLod.length);
            ohlcVisible = {
              from: lowerBound(ohlcTime, ohlcLod.length, range.from),
              to: upperBound(ohlcTime, ohlcLod.length, range.to),
            };
          }

          if (ohlcVisible.from < ohlcVisible.to) {
            const decimated = ohlcDecimator.decimate({
              seriesId: series.id,
              visibleRange: range,
              visibleIndices: ohlcVisible,
              time: ohlcTime,
              open: ohlcOpen,
              high: ohlcHigh,
              low: ohlcLow,
              close: ohlcClose,
              plotWidth: plotRect.width,
              scaleType: axisScaleType,
            });
            const lineColor = resolveLineColor(series);
            const barRatio = series.seriesType === 'candlestick' ? 0.7 : 0.6;
            const barWidth = resolveOhlcWidth(series, decimated.time.length, barRatio);
            if (series.seriesType === 'candlestick') {
              renderCandlestickSeries({
                ctx,
                surface,
                plotRect,
                xOffset,
                visibleRange: range,
                time: decimated.time,
                open: decimated.open,
                high: decimated.high,
                low: decimated.low,
                close: decimated.close,
                priceScale: axisScale,
                scaleMode: axisScale.getMode(),
                scaleBase: series.scaleBase,
                options: series.options as CandlestickSeriesOptions,
                defaultColor: lineColor,
                barWidth,
                dpr: resolvedDpr,
              });
            } else {
              renderOhlcBarSeries({
                ctx,
                surface,
                plotRect,
                xOffset,
                visibleRange: range,
                time: decimated.time,
                open: decimated.open,
                high: decimated.high,
                low: decimated.low,
                close: decimated.close,
                priceScale: axisScale,
                scaleMode: axisScale.getMode(),
                scaleBase: series.scaleBase,
                options: series.options as BarSeriesOptions,
                defaultColor: lineColor,
                barWidth,
                dpr: resolvedDpr,
              });
            }
          }
          continue;
        }
      }

      const decimated = decimator.decimate({
        seriesId: series.id,
        visibleRange: range,
        visibleIndices,
        time,
        value,
        plotWidth: plotRect.width,
        scaleType: axisScaleType,
      });
      const canCachePath =
        xOffset === 0 &&
        usePath2D &&
        typeof Path2D !== 'undefined' &&
        decimated.time.length <= PATH_CACHE_MAX_POINTS;
      const sourceKey = lodLevel ? `lod:${lodLevel.bucketSize}:${lodLevel.length}` : 'raw';
      const pathCacheKey = canCachePath
        ? buildPathCacheKey(
          series,
          range,
          plotRect,
          axisScale,
          axisScale.getMode(),
          series.scaleBase,
          axisScaleType,
          renderMode,
          gapThresholdMs,
          resolvedDpr,
          sourceKey,
          alignedLineWidth,
          decimated.time.length,
        )
        : undefined;
      renderSeriesByType(
        series,
        decimated.time,
        decimated.value,
        axisScale,
        renderMode,
        lineWidth,
        alignedLineWidth,
        canCachePath,
        pathCacheKey,
      );
    }
  };

  const buildPanOverscanRange = (range: VisibleTimeRange): VisibleTimeRange => {
    const span = range.to - range.from;
    if (!Number.isFinite(span) || span <= 0) return { ...range };
    return normalizeRange({
      from: range.from - span * panOverscanRatio,
      to: range.to + span * panOverscanRatio,
    });
  };

  const buildPanCache = (
    paneId: PaneId,
    axis: AxisId,
    range: VisibleTimeRange,
    plotRect: Rect,
    seriesGroup: InternalSeries[],
    axisScalePayload: SeriesWorkerScale,
  ): PanCacheState | null => {
    if (plotRect.width <= 0 || plotRect.height <= 0) return null;
    const span = range.to - range.from;
    if (!Number.isFinite(span) || span <= 0) return null;
    const size = seriesLayer.getSize();
    const dpr = size.dpr;
    const overscanRatio = panOverscanRatio;
    const overscanDevice = Math.round(plotRect.width * dpr * overscanRatio);
    const overscanPx = overscanDevice / dpr;
    const cacheWidth = plotRect.width + overscanPx * 2;
    const cacheHeight = plotRect.height;
    const cacheRange = buildPanOverscanRange(range);

    const key = getPanCacheKey(paneId, axis);
    const existing = panCaches.get(key);
    const canvas = existing?.canvas ?? document.createElement('canvas');
    const ctx = existing?.ctx ?? canvas.getContext('2d');
    if (!ctx) return null;

    const pixelWidth = Math.max(1, Math.round(cacheWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cacheHeight * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cacheWidth, cacheHeight);

    const cachePlotRect: Rect = {
      x: 0,
      y: 0,
      width: cacheWidth,
      height: cacheHeight,
    };
    const snapSurface = createSnapSurface(dpr);
    // V8 Fix: Pass visible plotRect.width AND visible range for bar width calculation
    // 'range' here is the base range (cacheBaseRange) without overscan, which matches direct rendering
    renderSeriesToContext(ctx, snapSurface, cachePlotRect, cacheRange, seriesGroup, range, dpr, 0, plotRect.width, range);

    const firstSeriesOrder = seriesGroup.reduce((min, series) => Math.min(min, series.order), Number.POSITIVE_INFINITY);
    const nextCache: PanCacheState = {
      axis,
      canvas,
      ctx,
      dpr,
      width: cacheWidth,
      height: cacheHeight,
      plotRect: { ...plotRect },
      range: cacheRange,
      overscanRatio,
      overscanPx,
      seriesRevision: seriesRenderRevision,
      themeVersion,
      scale: { ...axisScalePayload },
      firstSeriesOrder,
    };
    panCaches.set(key, nextCache);
    return nextCache;
  };

  const canUsePanCache = (
    paneId: PaneId,
    axis: AxisId,
    range: VisibleTimeRange,
    plotRect: Rect,
    axisScalePayload: SeriesWorkerScale,
  ): PanCacheState | null => {
    const cache = panCaches.get(getPanCacheKey(paneId, axis));
    if (!cache) return null;
    if (cache.axis !== axis) return null;
    if (!rangeContains(cache.range, range)) return null;
    const rangeSpan = range.to - range.from;
    const cacheSpan = cache.range.to - cache.range.from;
    if (!Number.isFinite(rangeSpan) || !Number.isFinite(cacheSpan) || rangeSpan <= 0 || cacheSpan <= 0) {
      return null;
    }
    const expectedSpan = rangeSpan * (1 + 2 * panOverscanRatio);
    const spanTolerance = Math.max(0.5, expectedSpan * 1e-6);
    if (Math.abs(cacheSpan - expectedSpan) > spanTolerance) {
      return null;
    }
    if (
      cache.plotRect.x !== plotRect.x ||
      cache.plotRect.y !== plotRect.y ||
      cache.plotRect.width !== plotRect.width ||
      cache.plotRect.height !== plotRect.height
    ) {
      return null;
    }
    if (cache.seriesRevision !== seriesRenderRevision) return null;
    if (cache.themeVersion !== themeVersion) return null;
    if (cache.overscanRatio !== panOverscanRatio) return null;
    if (cache.scale.type !== axisScalePayload.type) return null;
    if (cache.scale.type !== 'linear' && !scalesMatch(cache.scale, axisScalePayload)) return null;
    const dpr = seriesLayer.getSize().dpr;
    if (cache.dpr !== dpr) return null;
    return cache;
  };

  const canUseZoomCache = (
    paneId: PaneId,
    axis: AxisId,
    range: VisibleTimeRange,
    plotRect: Rect,
    axisScalePayload: SeriesWorkerScale,
  ): PanCacheState | null => {
    const cache = panCaches.get(getPanCacheKey(paneId, axis));
    if (!cache) return null;
    if (cache.axis !== axis) return null;
    if (!rangeContains(cache.range, range)) return null;
    const rangeSpan = range.to - range.from;
    const cacheSpan = cache.range.to - cache.range.from;
    if (!Number.isFinite(rangeSpan) || !Number.isFinite(cacheSpan) || rangeSpan <= 0 || cacheSpan <= 0) {
      return null;
    }
    const baseSpan = cacheSpan / (1 + 2 * cache.overscanRatio);
    const scale = rangeSpan / baseSpan;
    if (!Number.isFinite(scale) || scale < 0.5 || scale > 1.8) {
      return null;
    }
    if (
      cache.plotRect.x !== plotRect.x ||
      cache.plotRect.y !== plotRect.y ||
      cache.plotRect.width !== plotRect.width ||
      cache.plotRect.height !== plotRect.height
    ) {
      return null;
    }
    if (cache.seriesRevision !== seriesRenderRevision) return null;
    if (cache.themeVersion !== themeVersion) return null;
    if (cache.overscanRatio !== panOverscanRatio) return null;
    if (cache.scale.type !== axisScalePayload.type) return null;
    if (cache.scale.type !== 'linear' && !scalesMatch(cache.scale, axisScalePayload)) return null;
    const dpr = seriesLayer.getSize().dpr;
    if (cache.dpr !== dpr) return null;
    return cache;
  };

  const drawPanCache = (
    cache: PanCacheState,
    range: VisibleTimeRange,
    plotRect: Rect,
    axisScalePayload: SeriesWorkerScale,
    xOffset = 0,
  ): boolean => {
    const ctx = panLayer.context;
    if (!ctx) return false;
    const size = panLayer.getSize();
    const cacheSpan = cache.range.to - cache.range.from;
    if (!Number.isFinite(cacheSpan) || cacheSpan <= 0) return false;

    // Keep cache blit scale aligned with the cache render span.
    const scaleX = cache.width / cacheSpan;

    // Calculate offset: pixels from cache start to visible range start
    // This tells us where in the cache canvas the visible range begins
    const offset = (range.from - cache.range.from) * scaleX;
    const drawX = plotRect.x - offset + xOffset;
    const drawY = plotRect.y;

    // V8: Use raw float position for smooth sub-pixel panning
    // Previously used alignToDevicePixel which caused discrete pixel jumps during pan
    // Sub-pixel positioning allows the canvas to be translated smoothly
    // The slight blur from sub-pixel rendering is preferable to jittery motion

    const scaleType = cache.scale.type;
    const canTransform =
      scaleType === 'linear' &&
      axisScalePayload.type === 'linear' &&
      Number.isFinite(cache.scale.max) &&
      Number.isFinite(cache.scale.min) &&
      Number.isFinite(axisScalePayload.max) &&
      Number.isFinite(axisScalePayload.min);
    const oldSpan = cache.scale.max - cache.scale.min;
    const newSpan = axisScalePayload.max - axisScalePayload.min;
    const scaleY = canTransform && Number.isFinite(oldSpan) && Number.isFinite(newSpan) && oldSpan > 0 && newSpan > 0
      ? oldSpan / newSpan
      : 1;
    const translateY =
      canTransform && Number.isFinite(newSpan) && newSpan > 0
        ? (cache.height * (axisScalePayload.max - cache.scale.max)) / newSpan
        : 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    if (scaleY === 1 && translateY === 0) {
      ctx.drawImage(cache.canvas, drawX, drawY, cache.width, cache.height);
    } else {
      ctx.transform(1, 0, 0, scaleY, drawX, drawY + translateY);
      ctx.drawImage(cache.canvas, 0, 0, cache.width, cache.height);
    }
    ctx.restore();
    panCacheActive = true;
    return true;
  };

  const drawZoomCache = (
    cache: PanCacheState,
    range: VisibleTimeRange,
    plotRect: Rect,
    axisScalePayload: SeriesWorkerScale,
  ): boolean => {
    const ctx = panLayer.context;
    if (!ctx) return false;
    const cacheSpan = cache.range.to - cache.range.from;
    const rangeSpan = range.to - range.from;
    if (!Number.isFinite(cacheSpan) || cacheSpan <= 0) return false;
    if (!Number.isFinite(rangeSpan) || rangeSpan <= 0) return false;
    const scaleX = (cacheSpan / rangeSpan) * (plotRect.width / cache.width);
    const translateX =
      plotRect.x + ((cache.range.from - range.from) / rangeSpan) * plotRect.width;

    // V8: Use raw float position for smooth sub-pixel zooming

    const scaleType = cache.scale.type;
    const canTransform =
      scaleType === 'linear' &&
      axisScalePayload.type === 'linear' &&
      Number.isFinite(cache.scale.max) &&
      Number.isFinite(cache.scale.min) &&
      Number.isFinite(axisScalePayload.max) &&
      Number.isFinite(axisScalePayload.min);
    const oldSpan = cache.scale.max - cache.scale.min;
    const newSpan = axisScalePayload.max - axisScalePayload.min;
    const scaleY = canTransform && Number.isFinite(oldSpan) && Number.isFinite(newSpan) && oldSpan > 0 && newSpan > 0
      ? oldSpan / newSpan
      : 1;
    const translateY =
      canTransform && Number.isFinite(newSpan) && newSpan > 0
        ? (cache.height * (axisScalePayload.max - cache.scale.max)) / newSpan
        : 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.transform(scaleX, 0, 0, scaleY, translateX, plotRect.y + translateY);
    ctx.drawImage(cache.canvas, 0, 0, cache.width, cache.height);
    ctx.restore();
    panCacheActive = true;
    return true;
  };

  const updateSeriesLastValues = (range: VisibleTimeRange, providerRange: VisibleTimeRange): void => {
    for (const series of seriesList) {
      if (!series.visible) {
        clearSeriesLastValue(series);
        continue;
      }
      applyDirtyRange(series, providerRange);
      if (series.provider) {
        requestProviderRange(series, providerRange);
      }
      if (series.data.length === 0) {
        clearSeriesLastValue(series);
        continue;
      }
      const axisScale = getAxisScaleForSeries(series);

      if (isChunkedStore(series.data)) {
        const store = series.data;
        const visibleIndices = {
          from: store.lowerBound(range.from),
          to: store.upperBound(range.to),
        };
        let lastValue: number | null = null;
        for (let i = visibleIndices.to - 1; i >= visibleIndices.from; i -= 1) {
          const v = store.getValueAt(i);
          if (v !== null && Number.isFinite(v)) {
            lastValue = v;
            break;
          }
        }
        updateSeriesLastValue(series, lastValue, axisScale);
        continue;
      }

      const store = series.data;
      const values = store.values();
      const visibleIndices = {
        from: store.lowerBound(range.from),
        to: store.upperBound(range.to),
      };
      let lastValue: number | null = null;
      for (let i = visibleIndices.to - 1; i >= visibleIndices.from; i -= 1) {
        const v = values[i]!;
        if (Number.isFinite(v)) {
          lastValue = v;
          break;
        }
      }
      updateSeriesLastValue(series, lastValue, axisScale);
    }
  };

  const renderSeries = () => {
    decimator.resetFrameAllocations();
    ohlcDecimator.resetFrameAllocations();
    chunkedDecimator.resetFrameAllocations();
    if (!layoutState) return;
    const range = xScale.getVisibleRange();
    // DIAGNOSTIC: Trace range during pan
    const rangeSpan = range.to - range.from;
    if (panActive) {
      console.log('[PAN] renderSeries:', {
        range: { from: range.from, to: range.to, span: rangeSpan },
        panBaseRange: panBaseRange ? { from: panBaseRange.from, to: panBaseRange.to, span: panBaseRange.to - panBaseRange.from } : null,
        panOverscrollPx,
        panOverscrollRaw,
        seriesWorkerActive,
      });
    }
    if (!Number.isFinite(rangeSpan) || rangeSpan <= 0) {
      console.error('[Chart] renderSeries: Range collapsed!', {
        from: range.from,
        to: range.to,
        span: rangeSpan,
        panActive,
        panOverscrollPx,
      });
    }
    const { clamped: elasticRange, elasticActive } = resolveElasticRange(range);
    const elasticPan = elasticMode === 'pan' && elasticActive;
    const plotRect = layoutState.plotRect;
    const panOffsetPx = panOverscrollPx;
    const zoomActive = isZoomInteractionActive();
    if (!zoomActive) {
      zoomCacheCooldown = 0;
    }
    const allowZoomCache = zoomActive && renderQualityLevel > 1 && zoomCacheCooldown === 0;
    // DEBUG: Temporarily disable pan cache to diagnose drag issue
    const usePanCache = false;
    // Original: panOverscanRatio > 0 && (panActive || autoScrollEnabled || elasticPan || panOverscrollPx !== 0);
    const useCache = panOverscanRatio > 0 && (false || allowZoomCache); // Disabled pan cache
    let cacheBaseRange = elasticPan ? elasticRange : range;
    if (panActive) {
      if (!panBaseRange) {
        panBaseRange = cacheBaseRange;
      } else {
        const overscanRange = buildPanOverscanRange(panBaseRange);
        if (!rangeContains(overscanRange, range)) {
          panBaseRange = cacheBaseRange;
          invalidatePanCache();
        }
      }
      cacheBaseRange = panBaseRange ?? cacheBaseRange;
    }
    const cacheSpan = cacheBaseRange.to - cacheBaseRange.from;
    const memoryRange =
      useCache && Number.isFinite(cacheSpan) && cacheSpan > 0
        ? buildPanOverscanRange(cacheBaseRange)
        : cacheBaseRange;
    enforceMemoryPolicy(memoryRange);

    if (seriesWorkerActive) {
      const needsMainThread = seriesList.some(
        (series) =>
          series.visible &&
          (series.seriesType === 'area' ||
            series.seriesType === 'baseline' ||
            series.seriesType === 'histogram' ||
            series.seriesType === 'custom'),
      );
      if (needsMainThread) {
        disableSeriesWorker();
      }
    }

    if (panOverscanRatio > 0 && allowZoomCache && paneStates.length > 0) {
      updateSeriesLastValues(range, memoryRange);
      const cachesByPane = new Map<PaneId, Array<{ cache: PanCacheState; scale: SeriesWorkerScale }>>();
      let allReady = true;
      for (const paneState of paneStates) {
        const paneSeries = getPaneSeries(paneState.id);
        const paneCaches: Array<{ cache: PanCacheState; scale: SeriesWorkerScale }> = [];
        for (const axis of ['left', 'right'] as const) {
          const axisSeries = paneSeries.filter((series) => series.visible && series.axis === axis);
          if (axisSeries.length === 0) continue;

          const axisScalePayload = buildScalePayload(getAxisScale(paneState.id, axis), paneState.plotRect.height);
          if (axisScalePayload.type !== 'linear') {
            allReady = false;
            break;
          }
          const cache =
            canUseZoomCache(paneState.id, axis, range, paneState.plotRect, axisScalePayload) ??
            buildPanCache(paneState.id, axis, range, paneState.plotRect, axisSeries, axisScalePayload);
          if (!cache) {
            allReady = false;
            break;
          }
          paneCaches.push({ cache, scale: axisScalePayload });
        }
        if (!allReady) break;
        if (paneCaches.length > 0) {
          cachesByPane.set(paneState.id, paneCaches);
        }
      }

      if (allReady && panLayer.context) {
        setSeriesLayerHidden(true);
        const ctx = panLayer.context;
        const size = panLayer.getSize();
        ctx.clearRect(0, 0, size.cssWidth, size.cssHeight);
        for (const paneState of paneStates) {
          const caches = cachesByPane.get(paneState.id);
          if (!caches || caches.length === 0) continue;
          caches.sort((a, b) => a.cache.firstSeriesOrder - b.cache.firstSeriesOrder);
          for (const entry of caches) {
            drawZoomCache(entry.cache, range, paneState.plotRect, entry.scale);
          }
        }
        zoomCacheCooldown = 1;
        invalidate(InvalidationFlag.Series);
        return;
      }
    }

    if (usePanCache && paneStates.length > 0) {
      updateSeriesLastValues(range, memoryRange);
      const cachesByPane = new Map<PaneId, Array<{ cache: PanCacheState; scale: SeriesWorkerScale }>>();
      let allReady = true;
      for (const paneState of paneStates) {
        const paneSeries = getPaneSeries(paneState.id);
        const paneCaches: Array<{ cache: PanCacheState; scale: SeriesWorkerScale }> = [];
        for (const axis of ['left', 'right'] as const) {
          const axisSeries = paneSeries.filter((series) => series.visible && series.axis === axis);
          if (axisSeries.length === 0) continue;

          const axisScalePayload = buildScalePayload(getAxisScale(paneState.id, axis), paneState.plotRect.height);
          if (axisScalePayload.type !== 'linear') {
            allReady = false;
            break;
          }
          const cache =
            canUsePanCache(paneState.id, axis, range, paneState.plotRect, axisScalePayload) ??
            buildPanCache(paneState.id, axis, cacheBaseRange, paneState.plotRect, axisSeries, axisScalePayload);
          if (!cache) {
            allReady = false;
            break;
          }
          paneCaches.push({ cache, scale: axisScalePayload });
        }
        if (!allReady) break;
        if (paneCaches.length > 0) {
          cachesByPane.set(paneState.id, paneCaches);
        }
      }

      if (allReady && panLayer.context) {
        setSeriesLayerHidden(true);
        const ctx = panLayer.context;
        const size = panLayer.getSize();
        ctx.clearRect(0, 0, size.cssWidth, size.cssHeight);
        for (const paneState of paneStates) {
          const caches = cachesByPane.get(paneState.id);
          if (!caches || caches.length === 0) continue;
          caches.sort((a, b) => a.cache.firstSeriesOrder - b.cache.firstSeriesOrder);
          for (const entry of caches) {
            drawPanCache(entry.cache, range, paneState.plotRect, entry.scale, panOffsetPx);
          }
        }
        return;
      }
    }

    zoomCacheCooldown = 0;
    setSeriesLayerHidden(false);
    if (panCacheActive) {
      clearPanLayer();
    }

    if (!seriesWorkerActive) {
      const seriesCtx = seriesLayer.context;
      if (!seriesCtx) return;
      const size = seriesLayer.getSize();

      // DEBUG: Log direct rendering
      if (panActive) {
        console.log('[PAN] Direct rendering (no worker):', {
          range: { from: range.from, to: range.to, span: range.to - range.from },
          panOffsetPx,
          plotWidth: layoutState?.plotRect.width,
        });
      }

      seriesCtx.clearRect(0, 0, size.cssWidth, size.cssHeight);
      for (const paneState of paneStates) {
        if (paneState.plotRect.width <= 0 || paneState.plotRect.height <= 0) continue;
        const paneSeries = getPaneSeries(paneState.id);
        renderSeriesToContext(
          seriesCtx,
          seriesLayer,
          paneState.plotRect,
          range,
          paneSeries,
          range,
          undefined,
          panOffsetPx,
        );
      }
      return;
    }

    if (!seriesWorker) {
      disableSeriesWorker();
      renderSeries();
      return;
    }
    const defaultPaneState = getDefaultPaneState();
    const defaultScale = defaultPaneState
      ? buildScalePayload(
        getAxisScale(defaultPaneState.id, defaultPaneState.primaryAxis),
        defaultPaneState.plotRect.height,
      )
      : buildScalePayload(getAxisScale(defaultPaneId, 'left'), plotRect.height);
    if (plotRect.width <= 0 || plotRect.height <= 0) {
      const message: SeriesWorkerRenderMessage = {
        type: 'render',
        plotRect,
        visibleRange: range,
        scale: defaultScale,
        themeVersion,
        gapThresholdMs,
        series: [],
      };
      try {
        seriesWorker.postMessage(message);
      } catch {
        disableSeriesWorker();
        renderSeries();
      }
      return;
    }

    const workerSeries: SeriesWorkerSeries[] = [];
    const workerTransfer: Transferable[] = [];
    const seriesDpr = seriesLayer.getSize().dpr;
    const paneAxisVisibleCounts = new Map<PaneId, { left: number; right: number }>();

    for (const series of seriesList) {
      if (!series.visible) continue;
      const paneState = getPaneState(series.paneId);
      if (!paneState) continue;
      let visibleCount = 0;
      if (series.seriesType === 'candlestick' || series.seriesType === 'bar') {
        const ohlcStore = series.ohlcData;
        if (ohlcStore && ohlcStore.length > 0) {
          visibleCount = ohlcStore.upperBound(range.to) - ohlcStore.lowerBound(range.from);
        } else if (series.data.length > 0) {
          const store = series.data;
          visibleCount = store.upperBound(range.to) - store.lowerBound(range.from);
        }
      } else if (series.data.length > 0) {
        const store = series.data;
        visibleCount = store.upperBound(range.to) - store.lowerBound(range.from);
      }
      if (visibleCount <= 0) continue;
      const current = paneAxisVisibleCounts.get(series.paneId) ?? { left: 0, right: 0 };
      if (visibleCount > current[series.axis]) {
        current[series.axis] = visibleCount;
      }
      paneAxisVisibleCounts.set(series.paneId, current);
    }

    for (const series of seriesList) {
      if (!series.visible) {
        clearSeriesLastValue(series);
        continue;
      }
      applyDirtyRange(series, range);
      if (series.provider) {
        requestProviderRange(series, range);
      }
      if (series.data.length === 0) {
        clearSeriesLastValue(series);
        continue;
      }
      const paneState = getPaneState(series.paneId);
      if (!paneState) {
        clearSeriesLastValue(series);
        continue;
      }
      if (paneState.plotRect.width <= 0 || paneState.plotRect.height <= 0) {
        continue;
      }
      const axisScale = getAxisScaleForSeries(series);
      const axisScaleType = axisScale.getEffectiveType();
      const axisScalePayload = buildScalePayload(axisScale, paneState.plotRect.height);

      if (series.seriesType === 'candlestick' || series.seriesType === 'bar') {
        const ohlcStore = series.ohlcData;
        if (!ohlcStore || ohlcStore.length === 0) {
          clearSeriesLastValue(series);
          continue;
        }

        let ohlcTime = ohlcStore.times();
        let ohlcOpen = ohlcStore.opens();
        let ohlcHigh = ohlcStore.highs();
        let ohlcLow = ohlcStore.lows();
        let ohlcClose = ohlcStore.closes();
        let ohlcVisible = {
          from: ohlcStore.lowerBound(range.from),
          to: ohlcStore.upperBound(range.to),
        };
        const axisMaxVisible =
          paneAxisVisibleCounts.get(series.paneId)?.[series.axis] ??
          Math.max(0, ohlcVisible.to - ohlcVisible.from);
        const ohlcLod = series.ohlcLod?.pickLevel(axisMaxVisible, paneState.plotRect.width);
        if (ohlcLod && ohlcLod.length > 0) {
          ohlcTime = ohlcLod.time.subarray(0, ohlcLod.length);
          ohlcOpen = ohlcLod.open.subarray(0, ohlcLod.length);
          ohlcHigh = ohlcLod.high.subarray(0, ohlcLod.length);
          ohlcLow = ohlcLod.low.subarray(0, ohlcLod.length);
          ohlcClose = ohlcLod.close.subarray(0, ohlcLod.length);
          ohlcVisible = {
            from: lowerBound(ohlcTime, ohlcLod.length, range.from),
            to: upperBound(ohlcTime, ohlcLod.length, range.to),
          };
        }

        let lastValue: number | null = null;
        for (let i = ohlcVisible.to - 1; i >= ohlcVisible.from; i -= 1) {
          const v = ohlcClose[i]!;
          if (Number.isFinite(v)) {
            lastValue = v;
            break;
          }
        }
        updateSeriesLastValue(series, lastValue, axisScale);

        if (ohlcVisible.from >= ohlcVisible.to) continue;
        const decimated = ohlcDecimator.decimate({
          seriesId: series.id,
          visibleRange: range,
          visibleIndices: ohlcVisible,
          time: ohlcTime,
          open: ohlcOpen,
          high: ohlcHigh,
          low: ohlcLow,
          close: ohlcClose,
          plotWidth: paneState.plotRect.width,
          scaleType: axisScaleType,
        });
        if (decimated.time.length === 0) continue;

        const baseColor = resolveSeriesColor(series, series.order);
        const colors = resolveOhlcColors(series, baseColor);
        const barRatio = series.seriesType === 'candlestick' ? 0.7 : 0.6;
        const barWidth = resolveOhlcBarWidth(
          range,
          paneState.plotRect.width,
          series,
          decimated.time.length,
          barRatio,
          seriesDpr,
        );

        const timeCopy = cloneFloat64(decimated.time);
        const openCopy = cloneFloat64(decimated.open);
        const highCopy = cloneFloat64(decimated.high);
        const lowCopy = cloneFloat64(decimated.low);
        const closeCopy = cloneFloat64(decimated.close);

        workerSeries.push({
          id: series.id,
          seriesType: series.seriesType,
          time: timeCopy,
          open: openCopy,
          high: highCopy,
          low: lowCopy,
          close: closeCopy,
          barWidth,
          upColor: colors.up,
          downColor: colors.down,
          wickColor: colors.wick,
          borderVisible: colors.borderVisible,
          color: baseColor,
          width: series.options.width ?? 1,
          dash: series.options.dash ?? [],
          opacity: series.options.opacity ?? 1,
          renderMode: series.options.renderMode ?? 'linear',
          plotRect: paneState.plotRect,
          scale: axisScalePayload,
          scaleMode: axisScale.getMode(),
          scaleBase: series.scaleBase,
        });
        workerTransfer.push(
          timeCopy.buffer,
          openCopy.buffer,
          highCopy.buffer,
          lowCopy.buffer,
          closeCopy.buffer,
        );
        continue;
      }

      if (isChunkedStore(series.data)) {
        const store = series.data;
        const visibleIndices = {
          from: store.lowerBound(range.from),
          to: store.upperBound(range.to),
        };
        let lastValue: number | null = null;
        for (let i = visibleIndices.to - 1; i >= visibleIndices.from; i -= 1) {
          const v = store.getValueAt(i);
          if (v !== null && Number.isFinite(v)) {
            lastValue = v;
            break;
          }
        }
        updateSeriesLastValue(series, lastValue, axisScale);

        const rawChunks = store.getChunks();
        pruneChunkLods(series, rawChunks, retainLodOnly);
        const currentFrame = (chunkedLodFrame += 1);
        const activeStarts = new Set<number>();
        let lodUpdated = false;
        for (const chunk of rawChunks) {
          activeStarts.add(chunk.startTime);
          if (chunk.length < lodOptions.minPoints || paneState.plotRect.width <= 0) continue;
          if (chunk.endTime < range.from || chunk.startTime > range.to) continue;
          const from = lowerBound(chunk.time, chunk.length, range.from);
          const to = upperBound(chunk.time, chunk.length, range.to);
          const visibleCount = to - from;
          if (visibleCount <= paneState.plotRect.width) continue;
          const result = ensureChunkLod(series, chunk, currentFrame);
          if (result.changed) {
            lodUpdated = true;
          }
        }
        const lodOnlyChunks = collectLodOnlyChunks(series, range, activeStarts, currentFrame);
        if (lodUpdated) {
          chunkedDecimator.clearCache();
        }
        const lodEvicted = evictChunkLodsIfNeeded();
        if (lodEvicted) {
          chunkedDecimator.clearCache();
        }

        const chunkInputs = rawChunks.map((chunk) => {
          const base = {
            time: chunk.time,
            value: chunk.value,
            length: chunk.length,
          };
          const entry = series.chunkLods.get(chunk.startTime);
          return {
            startTime: chunk.startTime,
            chunk: entry ? { ...base, lod: entry.lod } : base,
          };
        });
        for (const chunk of lodOnlyChunks) {
          chunkInputs.push({
            startTime: chunk.startTime,
            chunk: {
              time: chunk.time,
              value: chunk.value,
              length: chunk.length,
              lod: chunk.lod,
            },
          });
        }
        chunkInputs.sort((a, b) => a.startTime - b.startTime);
        const chunks = chunkInputs.map((entry) => entry.chunk);

        if (visibleIndices.from >= visibleIndices.to && lodOnlyChunks.length === 0) continue;
        const decimated = chunkedDecimator.decimate({
          seriesId: series.id,
          version: store.version,
          visibleRange: range,
          plotWidth: paneState.plotRect.width,
          scaleType: axisScaleType,
          chunks,
        });
        const timeCopy = cloneFloat64(decimated.time);
        const valueCopy = cloneFloat64(decimated.value);
        workerSeries.push({
          id: series.id,
          seriesType: 'line',
          time: timeCopy,
          value: valueCopy,
          color: series.lastValueColor,
          width: series.options.width ?? 2,
          dash: series.options.dash ?? [],
          opacity: series.options.opacity ?? 1,
          renderMode: series.options.renderMode ?? 'linear',
          plotRect: paneState.plotRect,
          scale: axisScalePayload,
          scaleMode: axisScale.getMode(),
          scaleBase: series.scaleBase,
        });
        workerTransfer.push(timeCopy.buffer, valueCopy.buffer);
        continue;
      }

      const baseTime = series.data.times();
      const baseValue = series.data.values();
      const baseVisible = {
        from: series.data.lowerBound(range.from),
        to: series.data.upperBound(range.to),
      };

      let time = baseTime;
      let value = baseValue;
      let visibleIndices = baseVisible;
      const visibleCount = baseVisible.to - baseVisible.from;

      const axisMaxVisible = paneAxisVisibleCounts.get(series.paneId)?.[series.axis] ?? visibleCount;
      const lodLevel = series.lod.pickLevel(axisMaxVisible, paneState.plotRect.width);
      if (lodLevel && lodLevel.length > 0) {
        time = lodLevel.time.subarray(0, lodLevel.length);
        value = lodLevel.value.subarray(0, lodLevel.length);
        visibleIndices = {
          from: lowerBound(time, lodLevel.length, range.from),
          to: upperBound(time, lodLevel.length, range.to),
        };
      }

      let lastValue: number | null = null;
      for (let i = visibleIndices.to - 1; i >= visibleIndices.from; i -= 1) {
        const v = value[i]!;
        if (Number.isFinite(v)) {
          lastValue = v;
          break;
        }
      }
      updateSeriesLastValue(series, lastValue, axisScale);

      if (visibleIndices.from >= visibleIndices.to) continue;
      const decimated = decimator.decimate({
        seriesId: series.id,
        visibleRange: range,
        visibleIndices,
        time,
        value,
        plotWidth: paneState.plotRect.width,
        scaleType: axisScaleType,
      });
      const timeCopy = cloneFloat64(decimated.time);
      const valueCopy = cloneFloat64(decimated.value);
      workerSeries.push({
        id: series.id,
        seriesType: 'line',
        time: timeCopy,
        value: valueCopy,
        color: series.lastValueColor,
        width: series.options.width ?? 2,
        dash: series.options.dash ?? [],
        opacity: series.options.opacity ?? 1,
        renderMode: series.options.renderMode ?? 'linear',
        plotRect: paneState.plotRect,
        scale: axisScalePayload,
        scaleMode: axisScale.getMode(),
        scaleBase: series.scaleBase,
      });
      workerTransfer.push(timeCopy.buffer, valueCopy.buffer);
    }

    const message: SeriesWorkerRenderMessage = {
      type: 'render',
      plotRect,
      visibleRange: range,
      scale: defaultScale,
      themeVersion,
      gapThresholdMs,
      series: workerSeries,
    };
    try {
      seriesWorker.postMessage(message, workerTransfer);
    } catch {
      disableSeriesWorker();
      renderSeries();
    }
  };

  const renderCrosshairLabels = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    paneRect: Rect,
    paneState: PaneState | null,
  ) => {
    if (!layoutState || !paneState) return;

    ctx.save();
    ctx.font = paint.font;
    ctx.textBaseline = 'middle';

    const paddingX = Math.max(7, Math.round(paint.fontSizePx * 0.6));
    const paddingY = Math.max(4, Math.round(paint.fontSizePx * 0.35));
    const pillHeight = paint.fontSizePx + paddingY * 2;

    // 1. Time Axis Label (Bottom)
    if (layoutState.timeAxisRect) {
      const time = xScale.xToTime(x - layoutState.plotRect.x);
      const text = formatTime(time);
      const width = labelCache.measure(ctx, paint.font, text);
      const pillWidth = width + paddingX * 2;
      const labelX = clamp(x - pillWidth * 0.5, layoutState.timeAxisRect.x, layoutState.timeAxisRect.x + layoutState.timeAxisRect.width - pillWidth);

      ctx.fillStyle = paint.crosshair;
      ctx.fillRect(labelX, layoutState.timeAxisRect.y, pillWidth, pillHeight);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(text, labelX + pillWidth * 0.5, layoutState.timeAxisRect.y + pillHeight * 0.5);
    }

    // 2. Price Axis Labels (Left/Right) - Draw for ANY visible axis
    const drawPriceLabel = (axis: 'left' | 'right') => {
      const axisRect = axis === 'right' ? paneState.rightAxisRect : paneState.leftAxisRect;
      const axisScale = getAxisScale(paneState.id, axis);

      // Render if axis has width (is visible) and scale exists
      if (axisRect && axisScale && axisRect.width > 0) {
        const value = axisScale.yToValue(y - paneRect.y);
        const text = axisScale.format(value);
        const width = labelCache.measure(ctx, paint.font, text);
        const pillWidth = width + paddingX * 2;

        const labelY = clamp(y - pillHeight * 0.5, axisRect.y, axisRect.y + axisRect.height - pillHeight);
        // Right axis: align to left of axis rect (or just use x)
        // Left axis: align to right of axis rect
        const labelX = axis === 'right' ? axisRect.x : axisRect.x + axisRect.width - pillWidth;

        ctx.fillStyle = paint.crosshair;
        ctx.fillRect(labelX, labelY, pillWidth, pillHeight);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(text, labelX + paddingX, labelY + pillHeight * 0.5);
      }
    };

    drawPriceLabel('left');
    drawPriceLabel('right');

    ctx.restore();
  };

  const renderOverlay = () => {
    const ctx = overlay.context;
    if (!ctx) return;
    const size = overlay.getSize();
    ctx.clearRect(0, 0, size.cssWidth, size.cssHeight);

    if (!layoutState) return;
    const plotRect = layoutState.plotRect;
    const activePane = crosshairPaneId ? getPaneState(crosshairPaneId) : getDefaultPaneState();
    const paneRect = activePane?.plotRect ?? plotRect;

    const overlayState = buildPluginState(overlay);
    if (overlayState) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      ctx.clip();
      for (const plugin of plugins) {
        plugin.onRenderOverlay?.(ctx, overlayState);
      }
      ctx.restore();
    }

    const overlayNow = nowTime();
    const needsPriceAnimation = renderPriceLines(ctx, overlayNow);

    renderSeriesMarkers(ctx, panOverscrollPx);

    if (needsPriceAnimation) {
      invalidate(InvalidationFlag.Overlay);
    }

    const inPlot = isInsidePlot(crosshairX, crosshairY);
    // Show crosshair during pan for direct manipulation feel
    const crosshairVisible = crosshairActive && inPlot;
    if (crosshairVisible) {
      ctx.save();
      const snappedX = overlay.snapX(crosshairX);
      const snappedY = overlay.snapY(crosshairY);

      // V8 Update: Aesthetic "half dotted" (dashed) style
      const dashPattern = [4, 4];

      if (crosshairInGap) {
        ctx.globalAlpha = 0.5;  // Dimmed in gap
        ctx.setLineDash(dashPattern);
      } else {
        ctx.globalAlpha = 1.0; // Fully opaque for crisp look
        ctx.setLineDash(dashPattern);
      }

      ctx.strokeStyle = paint.crosshair;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(snappedX, plotRect.y);
      ctx.lineTo(snappedX, plotRect.y + plotRect.height);
      ctx.moveTo(paneRect.x, snappedY);
      ctx.lineTo(paneRect.x + paneRect.width, snappedY);
      ctx.stroke();
      ctx.restore();

      // Skip expensive label rendering during pan, but show crosshair lines
      if (!panActive) {
        renderCrosshairLabels(ctx, snappedX, snappedY, paneRect, activePane);
      }
    }

    renderLastValueMarkers(ctx, overlayNow);
    lastValueDirty = false;
  };

  const exportPng = async (options: ExportPngOptions = {}): Promise<ExportPngResult> => {
    if (destroyed) {
      throw new Error('Chart has been destroyed.');
    }
    if (typeof document === 'undefined') {
      throw new Error('Chart export requires a DOM environment.');
    }

    const size = underlay.getSize();
    const deterministic = options.deterministic === true;
    const ratio =
      typeof options.pixelRatio === 'number' && Number.isFinite(options.pixelRatio)
        ? Math.max(0.1, options.pixelRatio)
        : deterministic
          ? 1
          : size.dpr;
    const width = Math.max(1, Math.round(size.cssWidth * ratio));
    const height = Math.max(1, Math.round(size.cssHeight * ratio));

    if (!deterministic) {
      const output = document.createElement('canvas');
      output.width = width;
      output.height = height;

      const ctx = output.getContext('2d');
      if (!ctx) {
        return '';
      }

      const drawLayer = (layer: HTMLCanvasElement) => {
        ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, width, height);
      };

      drawLayer(underlay.canvas);
      drawLayer(seriesLayer.canvas);
      drawLayer(panLayer.canvas);
      drawLayer(overlay.canvas);

      if (typeof output.toBlob === 'function') {
        const blob = await new Promise<Blob | null>((resolve) =>
          output.toBlob(resolve, 'image/png'),
        );
        if (blob) return blob;
      }

      return output.toDataURL('image/png');
    }

    const exportContainer = document.createElement('div');
    exportContainer.style.position = 'fixed';
    exportContainer.style.left = '-10000px';
    exportContainer.style.top = '0';
    exportContainer.style.width = `${size.cssWidth}px`;
    exportContainer.style.height = `${size.cssHeight}px`;
    exportContainer.style.pointerEvents = 'none';
    exportContainer.style.opacity = '0';
    exportContainer.style.zIndex = '-1';
    document.body.appendChild(exportContainer);

    const exportTimeZone = options.timeZone ?? 'utc';
    const exportLocale = options.locale ?? EXPORT_DEFAULT_LOCALE;
    const exportFormatter = resolveExportTimeFormatter(exportLocale, exportTimeZone);
    const exportTheme = {
      ...theme,
      fontFamily: options.fontFamily ?? EXPORT_DEFAULT_FONT_FAMILY,
    };
    const range = xScale.getVisibleRange();

    const collectSeriesPoints = (series: InternalSeries): DataPoint[] => {
      if (series.data.length === 0) return [];
      if (isChunkedStore(series.data)) {
        const store = series.data;
        const from = store.lowerBound(range.from);
        const to = store.upperBound(range.to);
        const points: DataPoint[] = [];
        for (let i = from; i < to; i += 1) {
          const t = store.getTimeAt(i);
          if (t === null) continue;
          const v = store.getValueAt(i);
          points.push({ t, v: v !== null && Number.isFinite(v) ? v : null });
        }
        return points;
      }
      const store = series.data;
      const from = store.lowerBound(range.from);
      const to = store.upperBound(range.to);
      const times = store.times();
      const values = store.values();
      const points: DataPoint[] = [];
      for (let i = from; i < to; i += 1) {
        const t = times[i];
        if (t === undefined) continue;
        const v = values[i];
        points.push({
          t,
          v: typeof v === 'number' && Number.isFinite(v) ? v : null,
        });
      }
      return points;
    };
    const coerceHistogramValue = (value: number | null): number =>
      value === null ? Number.NaN : value;
    const collectHistogramPoints = (series: InternalSeries): HistogramDataPoint[] => {
      if (series.data.length === 0) return [];
      const overrides = histogramColorBySeries.get(series.id);
      if (isChunkedStore(series.data)) {
        const store = series.data;
        const from = store.lowerBound(range.from);
        const to = store.upperBound(range.to);
        const points: HistogramDataPoint[] = [];
        for (let i = from; i < to; i += 1) {
          const t = store.getTimeAt(i);
          if (t === null) continue;
          const v = coerceHistogramValue(store.getValueAt(i));
          const color = overrides?.get(t);
          points.push(color ? { t, v, color } : { t, v });
        }
        return points;
      }
      const store = series.data;
      const from = store.lowerBound(range.from);
      const to = store.upperBound(range.to);
      const times = store.times();
      const values = store.values();
      const points: HistogramDataPoint[] = [];
      for (let i = from; i < to; i += 1) {
        const t = times[i];
        if (t === undefined) continue;
        const v = coerceHistogramValue(values[i] ?? null);
        const color = overrides?.get(t);
        points.push(color ? { t, v, color } : { t, v });
      }
      return points;
    };
    const collectOhlcPoints = (series: InternalSeries): OhlcDataPoint[] => {
      const store = series.ohlcData;
      if (!store || store.length === 0) return [];
      const from = store.lowerBound(range.from);
      const to = store.upperBound(range.to);
      const times = store.times();
      const opens = store.opens();
      const highs = store.highs();
      const lows = store.lows();
      const closes = store.closes();
      const points: OhlcDataPoint[] = [];
      for (let i = from; i < to; i += 1) {
        const t = times[i];
        if (t === undefined) continue;
        const o = opens[i];
        if (o === undefined || !Number.isFinite(o)) continue;
        const h = highs[i];
        if (h === undefined || !Number.isFinite(h)) continue;
        const l = lows[i];
        if (l === undefined || !Number.isFinite(l)) continue;
        const c = closes[i];
        if (c === undefined || !Number.isFinite(c)) continue;
        points.push({ t, o, h, l, c });
      }
      return points;
    };

    let exportChart: Chart | null = null;
    try {
      const resolvedExportTimeZone = hasCustomScale ? timeZone : exportTimeZone;
      const resolvedExportFormatter = hasCustomScale ? formatTime : exportFormatter;
      exportChart = createChart(exportContainer, {
        autoSize: false,
        width: size.cssWidth,
        height: size.cssHeight,
        crosshairMode,
        ...(watermarkOptions ? { watermark: watermarkOptions } : {}),
        ...(gapThresholdMs !== null ? { gapThresholdMs } : {}),
        ...(rawRetentionMs !== null ? { rawRetentionMs } : {}),
        timeScale: { ...timeScaleOptions },
        timeZone: resolvedExportTimeZone,
        timeFormatter: resolvedExportFormatter,
        axis: { ...axisOptions },
        seriesRenderer: 'main',
      }, overrides);

      exportChart.setTheme(exportTheme);
      if (axisOptions.left) {
        exportChart.setAxisOptions('left', axisOptions.left);
      }
      if (axisOptions.right) {
        exportChart.setAxisOptions('right', axisOptions.right);
      }
      for (const plugin of plugins) {
        exportChart.addPlugin(plugin);
      }

      const exportPanes = resolveVisiblePanes();
      const paneMap = new Map<PaneId, PaneId>();
      paneMap.set(defaultPaneId, defaultPaneId);
      for (const pane of exportPanes) {
        if (pane.id === defaultPaneId) continue;
        paneMap.set(pane.id, exportChart.addPane(pane.preserveEmpty));
      }

      for (const series of seriesList) {
        const paneId = paneMap.get(series.paneId) ?? defaultPaneId;
        const seriesOptions = {
          ...series.options,
          paneId,
          axis: series.axis,
          visible: series.visible,
        };
        const exportSeries =
          series.seriesType === 'area'
            ? exportChart.addAreaSeries(seriesOptions as AreaSeriesOptions)
            : series.seriesType === 'baseline'
              ? exportChart.addBaselineSeries(seriesOptions as BaselineSeriesOptions)
              : series.seriesType === 'histogram'
                ? exportChart.addHistogramSeries(seriesOptions as HistogramSeriesOptions)
                : series.seriesType === 'candlestick'
                  ? exportChart.addCandlestickSeries(seriesOptions as CandlestickSeriesOptions)
                  : series.seriesType === 'bar'
                    ? exportChart.addBarSeries(seriesOptions as BarSeriesOptions)
                    : exportChart.addLineSeries(seriesOptions);
        if (series.seriesType === 'histogram') {
          (exportSeries as HistogramSeries).setData(collectHistogramPoints(series));
        } else if (series.seriesType === 'candlestick' || series.seriesType === 'bar') {
          (exportSeries as CandlestickSeries | BarSeries).setData(collectOhlcPoints(series));
        } else {
          (exportSeries as LineSeries).setData(collectSeriesPoints(series));
        }
        if (series.markers.length > 0) {
          (exportSeries as LineSeries).setMarkers(series.markers);
        }
        if (!series.visible) {
          exportSeries.setVisible(false);
        }
      }

      exportChart.setVisibleTimeRange(range);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      return await exportChart.exportPng({ pixelRatio: ratio });
    } finally {
      exportChart?.destroy();
      exportContainer.remove();
    }
  };

  const runtime = getChartRuntime();
  const runtimeHandle = runtime.createHandle(root);
  const runtimeVisiblePriority: RuntimePriority = 1;
  const runtimeInteractPriority: RuntimePriority = 2;
  let interactionTimer: number | null = null;

  const bumpInteractionPriority = (durationMs = 120): void => {
    runtimeHandle.setPriority(runtimeInteractPriority);
    if (interactionTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(interactionTimer);
    }
    if (typeof window !== 'undefined') {
      interactionTimer = window.setTimeout(() => {
        interactionTimer = null;
        runtimeHandle.setPriority(runtimeVisiblePriority);
      }, durationMs);
    }
  };

  runtimeHandle.setPriority(runtimeVisiblePriority);

  const scheduler = new FrameScheduler(
    ({ flags, intent }) => {
      const frameStart = nowTime();
      const interactionActive = isInteractionActive();

      // Update quality level based on previous frame's cost (uses lastFrameCostMs)
      // This happens BEFORE frameBudget.startFrame() because quality uses previous frame's metrics
      updateQualityLevel(interactionActive);

      // Process coalesced input events (latest pointer/wheel per frame)
      const coalescedIntent = inputCoalescer.processFrame();
      // Merge coalesced intent with scheduler intent (coalesced takes precedence)
      const mergedIntent: InputIntent = {
        ...intent,
        ...(coalescedIntent?.pointer && { pointer: coalescedIntent.pointer }),
        ...(coalescedIntent?.wheel && { wheel: coalescedIntent.wheel }),
      };

      let nextFlags = flags;
      const intentResult = applyIntent(mergedIntent);
      if (intentResult.changed) {
        hasCustomVisibleRange = true;
        nextFlags = (nextFlags | intentResult.flags) as InvalidationFlag;
      }
      const pointerIntent = coalescedIntent?.pointer;
      if (pointerIntent && pointerIntent.type === 'move') {
        const prevCrosshair = {
          active: crosshairActive,
          x: crosshairX,
          y: crosshairY,
          time: crosshairTime,
          paneId: crosshairPaneId,
        };
        updateCrosshairState(pointerIntent.x, pointerIntent.y);
        const crosshairChanged =
          prevCrosshair.active !== crosshairActive ||
          (crosshairActive &&
            (prevCrosshair.x !== crosshairX ||
              prevCrosshair.y !== crosshairY ||
              prevCrosshair.time !== crosshairTime ||
              prevCrosshair.paneId !== crosshairPaneId));
        const inPlot = isInsidePlot(pointerIntent.x, pointerIntent.y);
        if (layoutState && (inPlot || crosshairChanged)) {
          nextFlags = (nextFlags | InvalidationFlag.Overlay) as InvalidationFlag;
        }
        if (crosshairActive && inPlot) {
          pendingCrosshairEmit = true;
        }
      }
      if (pendingCrosshairEmit) {
        pendingCrosshairEmit = false;
        if (crosshairActive) {
          emitCrosshair(crosshairX, crosshairY);
        }
      }

      const forceCoherent = forceCoherentFrames > 0;
      if (forceCoherent) {
        nextFlags = (nextFlags | InvalidationFlag.Underlay | InvalidationFlag.Series | InvalidationFlag.Overlay) as InvalidationFlag;
      }

      const overlayScheduled = (nextFlags & InvalidationFlag.Overlay) !== 0;

      frameCount += 1;
      if (nextFlags & InvalidationFlag.Layout) {
        layoutCount += 1;
        underlayCount += 1;
      } else if (nextFlags & InvalidationFlag.Underlay) {
        underlayCount += 1;
      }
      if (nextFlags & InvalidationFlag.Series) seriesCount += 1;
      if (nextFlags & InvalidationFlag.Overlay) overlayCount += 1;

      // Start frame budget tracking for CURRENT frame
      // Note: This happens AFTER quality update because quality uses previous frame's metrics
      frameBudget.startFrame();

      // Capture render state snapshot for perfect layer synchronization
      // This ensures all render passes (underlay, series, overlay) use identical state
      // The snapshot is lightweight (just references) and provides:
      // 1. Atomic state capture (prevents state changes between passes)
      // 2. Debugging/monitoring capability (track state per frame)
      // 3. Frame coherence (coherent layers use same snapshot even when passes are skipped)
      const stateSnapshot = new RenderStateSnapshot(
        xScale.getVisibleRange(),
        panOverscrollPx,
        frameCount,
      );

      // Frame coherence (V7): Ensure coherent layers (underlay + series) stay synchronized
      // When both render together, they use the same state snapshot (captured at frame start)
      // When one is skipped due to budget, it continues showing the previous frame's content (canvas not cleared)
      // Track when both render together to ensure synchronization
      const willRenderUnderlay = (nextFlags & (InvalidationFlag.Layout | InvalidationFlag.Underlay)) !== 0;
      const forceSeries = interactionActive;
      const willRenderSeries =
        (nextFlags & InvalidationFlag.Series) !== 0 &&
        (!frameBudget.shouldSkip('standard') || forceCoherent || forceSeries);
      // Force overlay render during active interactions (pan/zoom) so drawings update live
      const willRenderOverlay =
        (nextFlags & InvalidationFlag.Overlay) !== 0 &&
        (interactionActive || !frameBudget.shouldSkip('optional') || forceCoherent);

      // Critical pass: Always execute (underlay - grid, axes, background)
      // Render functions are closures accessing current state - they naturally use the same state snapshot
      if (nextFlags & InvalidationFlag.Layout) {
        renderLayout();
      } else if (nextFlags & InvalidationFlag.Underlay) {
        renderUnderlay();
      }

      // Standard pass: Execute if budget allows (series rendering)
      // When skipped, series canvas shows previous frame (not cleared) - maintains coherence with underlay
      if (willRenderSeries) {
        renderSeries();
        if (lastValueDirty && !overlayScheduled) {
          invalidate(InvalidationFlag.Overlay);
        }
        // Mark snapshot as coherent if both underlay and series rendered together
        // This tracks that coherent layers are synchronized
        if (willRenderUnderlay) {
          lastCoherentSnapshot = stateSnapshot;
        }
      }

      // Optional pass: Execute if budget allows (overlay - crosshair, markers)
      // Overlay ALWAYS renders with current state (independent, not part of coherent group)
      // This ensures crosshair follows mouse even when coherent layers are skipped (V7 addendum requirement)
      if (willRenderOverlay) {
        renderOverlay();
      }

      if (forceCoherentFrames > 0) {
        forceCoherentFrames = Math.max(0, forceCoherentFrames - 1);
      }

      const frameCost = Math.max(0, nowTime() - frameStart);
      lastFrameCostMs = frameCost;
      frameCostTotalMs += frameCost;
      if (frameCost > frameCostMaxMs) {
        frameCostMaxMs = frameCost;
      }

      // Record frame time for performance monitoring (zero overhead when disabled)
      frameTimingMonitor.recordFrame(frameCost);
      lodWorkMsLast = lodWorkMsFrame;
      if (lodWorkMsFrame > lodWorkMsMax) {
        lodWorkMsMax = lodWorkMsFrame;
      }
      lodWorkMsFrame = 0;
      lodWorkOpsLast = lodWorkOpsFrame;
      if (lodWorkOpsFrame > lodWorkOpsMax) {
        lodWorkOpsMax = lodWorkOpsFrame;
      }
      lodWorkOpsFrame = 0;
    },
    {
      requestFrame: runtimeHandle.requestFrame,
      cancelFrame: runtimeHandle.cancelFrame,
    },
  );

  let batchDepth = 0;
  let batchedFlags: InvalidationFlag = InvalidationFlag.None;

  const invalidate = (flags: InvalidationFlag): void => {
    if (flags === InvalidationFlag.None) return;
    if (batchDepth > 0) {
      batchedFlags = (batchedFlags | flags) as InvalidationFlag;
      return;
    }
    scheduler.invalidate(flags);
  };

  const flushBatch = (): void => {
    if (batchedFlags === InvalidationFlag.None) return;
    const flags = batchedFlags;
    batchedFlags = InvalidationFlag.None;
    scheduler.invalidate(flags);
  };

  const runBatch = (fn: () => void): void => {
    batchDepth += 1;
    try {
      fn();
    } finally {
      batchDepth -= 1;
      if (batchDepth <= 0) {
        batchDepth = 0;
        flushBatch();
      }
    }
  };

  // Include Layout so grid is re-rendered with proper axis labels when series data changes
  scheduleSeriesInvalidate = () => invalidate(InvalidationFlag.Layout);

  if (debugRps && typeof window !== 'undefined') {
    logTimer = window.setInterval(() => {
      // eslint-disable-next-line no-console
      console.log(
        `[Charts+] fps=${frameCount} layout=${layoutCount} underlay=${underlayCount} series=${seriesCount} overlay=${overlayCount}`,
      );
      frameCount = 0;
      layoutCount = 0;
      underlayCount = 0;
      seriesCount = 0;
      overlayCount = 0;
    }, 1000);
  }

  const readRenderStats = (reset = false): RenderStats => {
    const memory = readMemoryStats();
    const retention = readRetentionStats();
    const stats: RenderStats = {
      frames: frameCount,
      layout: layoutCount,
      series: seriesCount,
      overlay: overlayCount,
      underlay: underlayCount,
      raf: frameCount,
      frameMsTotal: frameCostTotalMs,
      frameMsMax: frameCostMaxMs,
      frameMsLast: lastFrameCostMs,
      axisLabelMeasures: axisLabelMeasureCount,
      axisLabelDraws: axisLabelDrawCount,
      gridMajorLines: gridMajorLineCount,
      gridMinorLines: gridMinorLineCount,
      qualityLevel: renderQualityLevel,
      lodMsFrame: lodWorkMsFrame,
      lodMsLast: lodWorkMsLast,
      lodMsMax: lodWorkMsMax,
      lodMsTotal: lodWorkMsTotal,
      lodOpsFrame: lodWorkOpsFrame,
      lodOpsLast: lodWorkOpsLast,
      lodOpsMax: lodWorkOpsMax,
      lodOps: lodWorkOps,
      retention,
    };
    if (memory) {
      stats.memory = memory;
    }
    if (reset) {
      frameCount = 0;
      layoutCount = 0;
      underlayCount = 0;
      seriesCount = 0;
      overlayCount = 0;
      frameCostTotalMs = 0;
      frameCostMaxMs = 0;
      lastFrameCostMs = 0;
      axisLabelMeasureCount = 0;
      axisLabelDrawCount = 0;
      gridMajorLineCount = 0;
      gridMinorLineCount = 0;
      lodWorkMsFrame = 0;
      lodWorkMsLast = 0;
      lodWorkMsTotal = 0;
      lodWorkMsMax = 0;
      lodWorkOps = 0;
      lodWorkOpsFrame = 0;
      lodWorkOpsLast = 0;
      lodWorkOpsMax = 0;
    }
    return stats;
  };

  const readWorkerStats = (reset = false): WorkerStats => {
    const stats: WorkerStats = {
      lod: {
        queueDepth: lodRequests.size,
        totalMs: lodWorkerTotalMs,
        completed: lodWorkerCompleted,
      },
      chunkLod: {
        queueDepth: chunkLodRequests.size,
        totalMs: chunkLodWorkerTotalMs,
        completed: chunkLodWorkerCompleted,
      },
    };
    if (reset) {
      lodWorkerTotalMs = 0;
      lodWorkerCompleted = 0;
      chunkLodWorkerTotalMs = 0;
      chunkLodWorkerCompleted = 0;
      const now = nowTime();
      lodRequestTimes.forEach((_, requestId) => lodRequestTimes.set(requestId, now));
      chunkLodRequestTimes.forEach((_, requestId) => chunkLodRequestTimes.set(requestId, now));
    }
    return stats;
  };

  initSeriesWorker();

  const resize = () => {
    // V7: Check for DPR changes (window moved between displays)
    checkDprChange();

    const width = options.width ?? root.clientWidth;
    const height = options.height ?? root.clientHeight;
    underlay.resize(width, height);
    seriesLayer.resize(width, height);
    panLayer.resize(width, height);
    overlay.resize(width, height);
    postSeriesWorkerResize();
    labelCache.clear();
    clearPathCache();
    invalidatePanCache();
    pendingResizeAdjust = true;
    invalidate(InvalidationFlag.All);
  };

  const ro = options.autoSize ? new ResizeObserver(resize) : null;
  if (ro) {
    ro.observe(root);
  }
  resize();

  const getPointerSamples = (event: PointerEvent): PointerEvent[] => {
    if (typeof event.getCoalescedEvents === 'function') {
      const samples = event.getCoalescedEvents() as PointerEvent[];
      if (samples && samples.length > 0) return samples;
    }
    return [event];
  };

  const resolvePointerOffset = (event: PointerEvent): { x: number; y: number } => {
    const x = Number.isFinite(event.offsetX) ? event.offsetX : 0;
    const y = Number.isFinite(event.offsetY) ? event.offsetY : 0;
    return { x, y };
  };

  const resolvePointerTime = (event: PointerEvent): number => {
    const ts = event.timeStamp;
    if (Number.isFinite(ts) && ts > 0) return ts;
    return nowTime();
  };

  const accumulatePointerDeltas = (
    samples: PointerEvent[],
    startX: number,
    startY: number,
  ): { deltaX: number; deltaY: number; lastX: number; lastY: number } => {
    let deltaX = 0;
    let deltaY = 0;
    let lastX = startX;
    let lastY = startY;
    for (const sample of samples) {
      const pos = resolvePointerOffset(sample);
      deltaX += pos.x - lastX;
      deltaY += pos.y - lastY;
      lastX = pos.x;
      lastY = pos.y;
    }
    return { deltaX, deltaY, lastX, lastY };
  };

  const normalizeWheelDeltas = (
    event: WheelEvent,
    plotRect: Rect,
  ): { deltaX: number; deltaY: number; isTrackpad: boolean } => {
    let deltaX = event.deltaX;
    let deltaY = event.deltaY;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return { deltaX: 0, deltaY: 0, isTrackpad: false };
    }
    if (event.deltaMode === 1) {
      deltaX *= WHEEL_LINE_HEIGHT_PX;
      deltaY *= WHEEL_LINE_HEIGHT_PX;
    } else if (event.deltaMode === 2) {
      const pageSize = plotRect.height > 0 ? plotRect.height : WHEEL_PAGE_HEIGHT_FALLBACK;
      deltaX *= pageSize;
      deltaY *= pageSize;
    }

    const absMax = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    const isPinch = event.deltaMode === 0 && event.ctrlKey;
    const isTrackpad =
      !isPinch && event.deltaMode === 0 && absMax > 0 && absMax < WHEEL_TRACKPAD_THRESHOLD;
    const maxDelta = isTrackpad ? WHEEL_MAX_DELTA_PX : WHEEL_MAX_DELTA_PX * 1.5;
    deltaX = clamp(deltaX, -maxDelta, maxDelta);
    deltaY = clamp(deltaY, -maxDelta, maxDelta);

    const zoomScale = isPinch ? WHEEL_ZOOM_SCALE_PINCH : isTrackpad ? 1 : WHEEL_ZOOM_SCALE_MOUSE;
    return { deltaX, deltaY: deltaY * zoomScale, isTrackpad };
  };

  const emitCrosshair = (x: number, y: number) => {
    if (crosshairListeners.size === 0 || !layoutState) return;
    const plotRect = layoutState.plotRect;
    const localX = x - plotRect.x;
    const time = crosshairTime ?? xScale.xToTime(localX);
    const formattedTime = formatTime(time);

    const seriesValues = new Map<string, { value: number | null; formatted: string }>();
    for (const series of seriesList) {
      if (!series.visible) continue;
      let value = resolveSeriesValue(series, time);
      const axisScale = getAxisScaleForSeries(series);
      let formatted = formatSeriesValue(series, value, axisScale);
      if (crosshairMode === 'ohlc' && isOhlcSeries(series)) {
        const snapshot = resolveNearestOhlcSample(series, time);
        if (snapshot) {
          value = snapshot.close;
          const openText = formatSeriesValue(series, snapshot.open, axisScale);
          const highText = formatSeriesValue(series, snapshot.high, axisScale);
          const lowText = formatSeriesValue(series, snapshot.low, axisScale);
          const closeText = formatSeriesValue(series, snapshot.close, axisScale);
          formatted = `O:${openText} H:${highText} L:${lowText} C:${closeText}`;
        }
      }
      seriesValues.set(series.id, { value, formatted });
    }

    const ev: CrosshairMoveEvent = {
      time,
      formattedTime,
      x,
      y,
      paneId: crosshairPaneId ?? defaultPaneId,
      seriesValues,
    };
    crosshairListeners.forEach((cb) => cb(ev));
  };

  const clearCrosshair = (): void => {
    pendingExternalCrosshair = null;
    externalCrosshair = null;
    crosshairActive = false;
    crosshairPaneId = null;
    crosshairTime = null;
    pendingCrosshairEmit = false;
    invalidate(InvalidationFlag.Overlay);
  };

  const moveCrosshairBy = (deltaX: number, deltaY: number): boolean => {
    if (!layoutState) return false;
    const plotRect = layoutState.plotRect;
    if (plotRect.width <= 0 || plotRect.height <= 0) return false;
    const baseX = crosshairActive ? crosshairX : plotRect.x + plotRect.width * 0.5;
    const baseY = crosshairActive ? crosshairY : plotRect.y + plotRect.height * 0.5;
    const nextX = clamp(baseX + deltaX, plotRect.x, plotRect.x + plotRect.width);
    const nextY = clamp(baseY + deltaY, plotRect.y, plotRect.y + plotRect.height);
    updateCrosshairState(nextX, nextY, false);
    scheduler.invalidate(InvalidationFlag.Overlay);
    if (crosshairActive) {
      emitCrosshair(nextX, nextY);
    }
    return true;
  };

  const supportsPointerRawUpdate =
    typeof window !== 'undefined' && 'onpointerrawupdate' in window;

  const beginAxisDrag = (x: number, y: number, pointerId: number): boolean => {
    if (!handleScaleAxisDrag) return false;
    const target = getAxisDragTarget(x, y);
    if (!target) return false;

    // Handle time axis (X-axis) drag
    if (target.axis === 'time') {
      const visibleRange = xScale.getVisibleRange();
      if (!Number.isFinite(visibleRange.from) || !Number.isFinite(visibleRange.to) || visibleRange.to <= visibleRange.from) {
        return false;
      }
      const localX = clamp(x - target.plotRect.x, 0, target.plotRect.width);

      const span = visibleRange.to - visibleRange.from;

      // Anchor to the RIGHT EDGE to match wheel zoom behavior ("last candle in focus")
      // This ensures zooming expands/contracts towards the past (left)
      const anchorValue = visibleRange.to;
      const anchorRatio = 1;

      // Calculate position-based sensitivity (RHS = higher, LHS = lower)
      // Quadratic curve for "smart" sensitivity:
      // - LHS (0.0): 0.05x (Extremely precise for historical data)
      // - RHS (1.0): 1.5x (Standard speed for recent data)
      // - Contrast: 30x difference (vs 6.7x linear)
      const width = target.plotRect.width || 1;
      const relativePos = clamp(localX / width, 0, 1);
      const sensitivityMultiplier = 0.05 + Math.pow(relativePos, 2) * 1.5;

      axisDragState = {
        pointerId,
        paneId: target.paneId,
        axis: 'time',
        startY: y,
        startX: x,
        anchorRatio,
        anchorValue,
        span,
        scaleType: 'linear',
        startRange: { min: visibleRange.from, max: visibleRange.to, minPositive: 1 },
        sensitivityMultiplier,
      };

      if (typeof overlay.canvas.setPointerCapture === 'function') {
        overlay.canvas.setPointerCapture(pointerId);
      }
      cancelInertia();
      endPan();
      markInteraction('zoom');
      invalidatePanCache();
      invalidate(InvalidationFlag.Layout);
      return true;
    }

    // Handle Y-axis drag (existing logic)
    const axisScale = getAxisScale(target.paneId, target.axis as AxisId);
    const range = axisScale.getRange();
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) {
      return false;
    }
    const minPositive = axisScale.getMinPositive();
    const localY = clamp(y - target.plotRect.y, 0, target.plotRect.height);
    const anchorValue = axisScale.yToValue(localY);
    if (!Number.isFinite(anchorValue)) return false;

    const scaleType = axisScale.getEffectiveType();
    let anchorRatio = 0.5; // Force center anchor for consistent zoom behavior
    let span = range.max - range.min;
    let logMin: number | undefined;
    let logSpan: number | undefined;
    let anchorLog: number | undefined;

    // Y-axis always anchors at center of visible range (scale-invariant behavior)
    // calculate position-based sensitivity (Bottom = higher, Top = lower)
    // 0.5x at top edge -> 1.5x at bottom edge
    const height = target.plotRect.height || 1;
    const relativePos = clamp(localY / height, 0, 1);
    const sensitivityMultiplier = 0.5 + relativePos * 1.0;

    // Override anchorValue to use the center of the visible range
    const centerValue = (range.min + range.max) / 2;

    if (scaleType === 'log') {
      const safeMin = Math.max(minPositive, 1e-12);
      const logMinValue = Math.log10(safeMin);
      const logMaxValue = Math.log10(range.max);
      const spanLog = logMaxValue - logMinValue;
      if (!Number.isFinite(spanLog) || spanLog <= 0) return false;
      // For log scale, anchor at geometric center
      const logCenterValue = (logMinValue + logMaxValue) / 2;
      logMin = logMinValue;
      logSpan = spanLog;
      anchorLog = logCenterValue;
      span = spanLog;
    } else if (!Number.isFinite(span) || span <= 0) {
      return false;
    }
    // else: linear scale uses centerValue and anchorRatio=0.5 (already set)

    const manualRange: AxisManualRange = {
      min: range.min,
      max: range.max,
      minPositive,
    };
    axisManualRanges.set(getAxisOverrideKey(target.paneId, target.axis as AxisId), manualRange);

    const axisDragBase = {
      pointerId,
      paneId: target.paneId,
      axis: target.axis,
      startY: y,
      startX: x,
      anchorRatio,
      anchorValue: centerValue, // Use center value, not click position
      span,
      scaleType,
      startRange: manualRange,
      sensitivityMultiplier,
    };
    axisDragState =
      scaleType === 'log'
        ? {
          ...axisDragBase,
          logMin: logMin!,
          logSpan: logSpan!,
          anchorLog: anchorLog!,
        }
        : axisDragBase;
    if (typeof overlay.canvas.setPointerCapture === 'function') {
      overlay.canvas.setPointerCapture(pointerId);
    }
    cancelInertia();
    endPan();
    markInteraction('zoom');
    invalidatePanCache();
    invalidate(InvalidationFlag.Layout);
    return true;
  };

  const updateAxisDrag = (x: number, y: number): void => {
    if (!axisDragState) return;

    // Handle time axis (X-axis) drag
    if (axisDragState.axis === 'time') {
      const deltaX = x - axisDragState.startX;
      const sensitivity = AXIS_DRAG_SENSITIVITY * (axisDragState.sensitivityMultiplier ?? 1);
      let scale = Math.exp(deltaX * sensitivity);
      if (!Number.isFinite(scale)) return;
      scale = clamp(scale, AXIS_DRAG_MIN_SCALE, AXIS_DRAG_MAX_SCALE);

      const newSpan = axisDragState.span * scale;
      const newFrom = axisDragState.anchorValue - axisDragState.anchorRatio * newSpan;
      const newTo = newFrom + newSpan;

      if (!Number.isFinite(newFrom) || !Number.isFinite(newTo) || newTo <= newFrom) return;

      xScale.setVisibleRange({ from: newFrom, to: newTo });
      markInteraction('zoom');
      invalidatePanCache();
      // Include Overlay so drawing objects update continuously during X-axis drag
      invalidate(InvalidationFlag.Layout | InvalidationFlag.Overlay);
      return;
    }

    // Handle Y-axis drag (existing logic)
    const deltaY = y - axisDragState.startY;
    const sensitivity = AXIS_DRAG_SENSITIVITY * (axisDragState.sensitivityMultiplier ?? 1);
    let scale = Math.exp(deltaY * sensitivity);
    if (!Number.isFinite(scale)) return;
    scale = clamp(scale, AXIS_DRAG_MIN_SCALE, AXIS_DRAG_MAX_SCALE);

    let nextRange: AxisManualRange | null = null;
    if (axisDragState.scaleType === 'log') {
      const logSpan = axisDragState.logSpan ?? 0;
      const logMin = axisDragState.logMin ?? 0;
      const anchorLog = axisDragState.anchorLog ?? 0;
      if (!Number.isFinite(logSpan) || logSpan <= 0) return;
      const minSpan = Math.max(AXIS_DRAG_MIN_LOG_SPAN, logSpan * 1e-6);
      const nextSpan = Math.max(minSpan, logSpan * scale);
      const nextLogMin = anchorLog - axisDragState.anchorRatio * nextSpan;
      const nextLogMax = nextLogMin + nextSpan;
      if (!Number.isFinite(nextLogMin) || !Number.isFinite(nextLogMax)) return;
      const min = Math.pow(10, nextLogMin);
      const max = Math.pow(10, nextLogMax);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
      nextRange = { min, max, minPositive: Math.max(1e-12, min) };
    } else {
      const span = axisDragState.span;
      if (!Number.isFinite(span) || span <= 0) return;
      const minSpan = Math.max(1e-9, span * 1e-6);
      const nextSpan = Math.max(minSpan, span * scale);
      const anchorValue = axisDragState.anchorValue;
      const nextMin = anchorValue - axisDragState.anchorRatio * nextSpan;
      const nextMax = nextMin + nextSpan;
      if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax) || nextMax <= nextMin) return;
      nextRange = {
        min: nextMin,
        max: nextMax,
        minPositive: axisDragState.startRange.minPositive,
      };
    }

    axisManualRanges.set(getAxisOverrideKey(axisDragState.paneId, axisDragState.axis as AxisId), nextRange);
    markInteraction('zoom');
    invalidatePanCache();
    // Include Overlay so drawing objects update continuously during axis drag
    invalidate(InvalidationFlag.Layout | InvalidationFlag.Overlay);
  };

  const endAxisDrag = (pointerId: number): void => {
    if (!axisDragState || axisDragState.pointerId !== pointerId) return;
    axisDragState = null;
    overlay.canvas.style.cursor = '';
    if (typeof overlay.canvas.hasPointerCapture === 'function' && overlay.canvas.hasPointerCapture(pointerId)) {
      overlay.canvas.releasePointerCapture(pointerId);
    }
  };

  const beginPaneResize = (dividerIndex: number, startY: number, pointerId: number): void => {
    const topPane = paneStates[dividerIndex];
    const bottomPane = paneStates[dividerIndex + 1];
    if (!topPane || !bottomPane) return;
    const topHeight = paneHeightsById.get(topPane.id) ?? topPane.plotRect.height;
    const bottomHeight = paneHeightsById.get(bottomPane.id) ?? bottomPane.plotRect.height;
    paneResizeActive = {
      index: dividerIndex,
      startY,
      topId: topPane.id,
      bottomId: bottomPane.id,
      topHeight,
      bottomHeight,
    };
    paneResizePointerId = pointerId;
    overlay.canvas.setPointerCapture(pointerId);
    cancelInertia();
    endPan();
    invalidate(InvalidationFlag.Layout);
  };

  const updatePaneResize = (y: number): void => {
    if (!paneResizeActive || !layoutState) return;
    const totalHeight = paneResizeActive.topHeight + paneResizeActive.bottomHeight;
    const minHeight = resolveMinPaneHeight(layoutState.plotRect.height, paneStates.length);
    const delta = y - paneResizeActive.startY;
    let nextTop = paneResizeActive.topHeight + delta;
    nextTop = clamp(nextTop, minHeight, totalHeight - minHeight);
    const nextBottom = Math.max(minHeight, totalHeight - nextTop);
    const topPane = paneById.get(paneResizeActive.topId);
    const bottomPane = paneById.get(paneResizeActive.bottomId);
    if (topPane) {
      topPane.fixedHeight = Math.round(nextTop);
    }
    if (bottomPane) {
      bottomPane.fixedHeight = Math.round(nextBottom);
    }
    invalidatePanCache();
    invalidate(InvalidationFlag.Layout);
  };

  const endPaneResize = (pointerId: number): void => {
    if (paneResizePointerId !== pointerId) return;
    paneResizePointerId = null;
    paneResizeActive = null;
    overlay.canvas.style.cursor = '';
    invalidate(InvalidationFlag.Layout);
    if (overlay.canvas.hasPointerCapture(pointerId)) {
      overlay.canvas.releasePointerCapture(pointerId);
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    bumpInteractionPriority();
    crosshairShiftActive = e.shiftKey;
    lastPointerX = e.offsetX;
    lastPointerY = e.offsetY;
    hasPointerPosition = true;
    scheduler.queuePointerDown(e.offsetX, e.offsetY);
    updateCrosshairState(e.offsetX, e.offsetY);
    const pluginConsumed = dispatchPluginPointer('down', e.offsetX, e.offsetY);
    if (!layoutState) return;
    cancelInertia();
    resetPanVelocity();

    // If a plugin consumed the event (e.g., drawing object interaction), skip chart pan
    if (pluginConsumed) return;

    if (e.pointerType === 'mouse' && e.button === 0) {
      if (beginAxisDrag(e.offsetX, e.offsetY, e.pointerId)) {
        return;
      }
    }

    if (!isInsidePlot(e.offsetX, e.offsetY)) return;

    if (paneResizeEnabled) {
      const dividerIndex = getPaneDividerIndex(e.offsetX, e.offsetY);
      if (dividerIndex !== null) {
        beginPaneResize(dividerIndex, e.offsetY, e.pointerId);
        return;
      }
    }

    if (e.pointerType === 'touch') {
      activeTouches.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      overlay.canvas.setPointerCapture(e.pointerId);
      updateTouchGesture(resolvePointerTime(e));
      return;
    }

    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'mouse' && !handleScrollPressedMouseMove) return;
    dragPointerId = e.pointerId;
    dragLastX = e.offsetX;
    dragLastY = e.offsetY;
    overlay.canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (event: Event) => {
    const e = event as PointerEvent;
    crosshairShiftActive = e.shiftKey;

    if (axisDragState && axisDragState.pointerId === e.pointerId) {
      bumpInteractionPriority();
      updateAxisDrag(e.offsetX, e.offsetY);
      return;
    }
    if (paneResizePointerId === e.pointerId && paneResizeActive) {
      updatePaneResize(e.offsetY);
      return;
    }
    if (
      e.pointerType === 'mouse' &&
      paneResizePointerId === null &&
      dragPointerId === null &&
      axisDragState === null &&
      activeTouches.size === 0
    ) {
      const dividerIndex = paneResizeEnabled ? getPaneDividerIndex(e.offsetX, e.offsetY) : null;
      if (dividerIndex !== null) {
        overlay.canvas.style.cursor = 'row-resize';
      } else if (handleScaleAxisDrag) {
        const target = getAxisDragTarget(e.offsetX, e.offsetY);
        if (target) {
          overlay.canvas.style.cursor = target.axis === 'time' ? 'ew-resize' : 'ns-resize';
        } else {
          overlay.canvas.style.cursor = '';
        }
      } else {
        overlay.canvas.style.cursor = '';
      }
    }
    if (e.type === 'pointerrawupdate' && dragPointerId === null && activeTouches.size === 0) {
      return;
    }
    if (supportsPointerRawUpdate && e.type === 'pointermove' && dragPointerId !== null) {
      return;
    }
    const samples = getPointerSamples(e);
    const latestSample = samples[samples.length - 1] ?? e;
    const latestPos = resolvePointerOffset(latestSample);
    const latestTime = resolvePointerTime(latestSample);
    lastPointerX = latestPos.x;
    lastPointerY = latestPos.y;
    hasPointerPosition = true;
    const inPlot = isInsidePlot(latestPos.x, latestPos.y);
    if (layoutState && (inPlot || (crosshairActive && !externalCrosshair))) {
      inputCoalescer.queuePointerMove(latestPos.x, latestPos.y, latestTime);
      scheduler.invalidate(InvalidationFlag.Overlay);
    }
    dispatchPluginPointer('move', latestPos.x, latestPos.y);

    if (e.pointerType === 'touch') {
      if (!activeTouches.has(e.pointerId)) return;
      activeTouches.set(e.pointerId, { x: latestPos.x, y: latestPos.y });
      bumpInteractionPriority();
      updateTouchGesture(latestTime);
      return;
    }

    if (dragPointerId !== e.pointerId) return;
    bumpInteractionPriority();
    const { deltaX, deltaY, lastX, lastY } = accumulatePointerDeltas(samples, dragLastX, dragLastY);
    dragLastX = lastX;
    dragLastY = lastY;
    if (deltaX !== 0 || deltaY !== 0) {
      queueTouchPan(deltaX, deltaY, lastX, lastY, 'mouse', latestTime);
    }
  };

  const endPointer = (e: PointerEvent) => {
    scheduler.queuePointerUp(e.offsetX, e.offsetY);
    dispatchPluginPointer('up', e.offsetX, e.offsetY);

    // Always release pointer capture if we have it, regardless of which interaction is active
    // This ensures cleanup even if state is inconsistent
    if (typeof overlay.canvas.hasPointerCapture === 'function' && overlay.canvas.hasPointerCapture(e.pointerId)) {
      overlay.canvas.releasePointerCapture(e.pointerId);
    }

    if (paneResizePointerId === e.pointerId) {
      endPaneResize(e.pointerId);
      return;
    }
    if (axisDragState && axisDragState.pointerId === e.pointerId) {
      endAxisDrag(e.pointerId);
      return;
    }
    const eventTime = resolvePointerTime(e);
    if (e.pointerType === 'touch') {
      activeTouches.delete(e.pointerId);
      updateTouchGesture(eventTime);
      if (activeTouches.size === 0) {
        startInertia('touch', eventTime);
        if (!inertiaActive) {
          endPan();
        }
      }
    }
    if (dragPointerId === e.pointerId) {
      dragPointerId = null;
      startInertia('mouse', eventTime);
      if (!inertiaActive) {
        endPan();
      }
    }
  };

  const onPointerLeave = (e: PointerEvent) => {
    crosshairShiftActive = false;
    inputCoalescer.clearPointerMove();
    dispatchPluginPointer('leave', e.offsetX, e.offsetY);
    overlay.canvas.style.cursor = '';
    if (crosshairActive && !externalCrosshair) {
      crosshairActive = false;
      crosshairPaneId = null;
      crosshairTime = null;
    }
    pendingCrosshairEmit = false;
    invalidate(InvalidationFlag.Overlay);

    // Release pointer capture if active (defensive cleanup)
    // Note: If pointer is captured, pointerleave may not fire, but this handles edge cases
    if (typeof overlay.canvas.hasPointerCapture === 'function' && overlay.canvas.hasPointerCapture(e.pointerId)) {
      overlay.canvas.releasePointerCapture(e.pointerId);
      // Also clear drag state to prevent stuck state
      if (dragPointerId === e.pointerId) {
        dragPointerId = null;
        endPan();
      }
      if (paneResizePointerId === e.pointerId) {
        endPaneResize(e.pointerId);
      }
      if (axisDragState && axisDragState.pointerId === e.pointerId) {
        endAxisDrag(e.pointerId);
      }
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (!layoutState || !isInsidePlot(e.offsetX, e.offsetY)) return;
    if (!handleScrollMouseWheel && !handleScaleMouseWheel) return;
    if (dragPointerId !== null || activeTouches.size > 0 || axisDragState || paneResizeActive) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    bumpInteractionPriority();
    cancelInertia();
    const normalized = normalizeWheelDeltas(e, layoutState.plotRect);
    const deltaX = handleScrollMouseWheel ? normalized.deltaX : 0;
    const deltaY = handleScaleMouseWheel ? normalized.deltaY : 0;
    if (deltaX === 0 && deltaY === 0) return;
    if (deltaY !== 0) {
      markInteraction('zoom');
      markElasticInteraction('zoom');
      // Clear grid cache and invalidate tick coordinator on zoom
      clearGridCache();
      tickCoordinator.invalidateOnZoom();
      // Clear coordinate stabilization cache on zoom (coordinates change significantly)
      underlay.clearStabilization();
      seriesLayer.clearStabilization();
      overlay.clearStabilization();
    } else if (deltaX !== 0) {
      markInteraction('pan');
      markElasticInteraction('pan');
    }
    if (deltaX !== 0) {
      beginPan();
      scheduleWheelPanEnd();
    }
    // Coalesce wheel events to reduce render calls during fast scrolling
    // V7: Pass Ctrl key state for right-edge zoom (Ctrl = cursor anchor, default = right edge)
    inputCoalescer.queueWheel(deltaX, deltaY, e.offsetX, e.offsetY, performance.now(), e.ctrlKey);
    scheduler.invalidate(InvalidationFlag.All);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (destroyed || !layoutState) return;
    if (e.target !== root) return;
    const plotRect = layoutState.plotRect;
    if (plotRect.width <= 0 || plotRect.height <= 0) return;

    const panStep = Math.max(12, Math.round(plotRect.width * 0.05));
    const crosshairStep = Math.max(8, Math.round(plotRect.width * 0.02));
    const zoomStep = 120;
    const anchorX = plotRect.x + plotRect.width * 0.5;
    const anchorY = plotRect.y + plotRect.height * 0.5;
    const applyKeyboardWheel = (deltaX: number, deltaY: number): boolean => {
      const result = applyIntent({
        wheel: { deltaX, deltaY, x: anchorX, y: anchorY },
      });
      if (result.changed) {
        invalidate(result.flags);
      }
      return result.changed;
    };

    let handled = false;
    switch (e.key) {
      case 'ArrowLeft':
        if (e.shiftKey) {
          handled = moveCrosshairBy(-crosshairStep, 0);
          break;
        }
        cancelInertia();
        markInteraction('pan');
        markElasticInteraction('pan');
        beginPan();
        scheduleWheelPanEnd();
        handled = applyKeyboardWheel(panStep, 0);
        break;
      case 'ArrowRight':
        if (e.shiftKey) {
          handled = moveCrosshairBy(crosshairStep, 0);
          break;
        }
        cancelInertia();
        markInteraction('pan');
        markElasticInteraction('pan');
        beginPan();
        scheduleWheelPanEnd();
        handled = applyKeyboardWheel(-panStep, 0);
        break;
      case 'ArrowUp':
        if (e.shiftKey) {
          handled = moveCrosshairBy(0, -crosshairStep);
          break;
        }
        cancelInertia();
        markInteraction('zoom');
        markElasticInteraction('zoom');
        handled = applyKeyboardWheel(0, -zoomStep);
        break;
      case 'ArrowDown':
        if (e.shiftKey) {
          handled = moveCrosshairBy(0, crosshairStep);
          break;
        }
        cancelInertia();
        markInteraction('zoom');
        markElasticInteraction('zoom');
        handled = applyKeyboardWheel(0, zoomStep);
        break;
      case '+':
      case '=':
        cancelInertia();
        markInteraction('zoom');
        markElasticInteraction('zoom');
        handled = applyKeyboardWheel(0, -zoomStep);
        break;
      case '-':
      case '_':
        cancelInertia();
        markInteraction('zoom');
        markElasticInteraction('zoom');
        handled = applyKeyboardWheel(0, zoomStep);
        break;
      case 'c':
      case 'C':
        if (crosshairActive && !externalCrosshair) {
          clearCrosshair();
          handled = true;
          break;
        }
        handled = moveCrosshairBy(0, 0);
        break;
      case 'Escape':
        if (crosshairActive || externalCrosshair) {
          clearCrosshair();
          handled = true;
        }
        break;
      default:
        break;
    }

    if (handled) {
      e.preventDefault();
    }
  };

  const onDblClick = (e: MouseEvent) => {
    if (!layoutState) return;
    const x = e.offsetX;
    const y = e.offsetY;

    // Check if double-clicked on X-axis
    if (layoutState.timeAxisRect) {
      const rect = layoutState.timeAxisRect;
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
        hasCustomVisibleRange = false;
        autoScrollEnabled = true;
        syncTimeScaleToData();
        invalidatePanCache();
        invalidate(InvalidationFlag.Layout);
        return;
      }
    }

    // Check if double-clicked on Y-axis (any pane)
    const target = getAxisDragTarget(x, y);
    if (target) {
      if (target.axis !== 'time') {
        axisManualRanges.delete(getAxisOverrideKey(target.paneId, target.axis as AxisId));
      }
      invalidatePanCache();
      invalidate(InvalidationFlag.Layout);
      return;
    }
  };

  overlay.canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
  overlay.canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  if (supportsPointerRawUpdate) {
    overlay.canvas.addEventListener('pointerrawupdate', onPointerMove, { passive: true });
  }
  overlay.canvas.addEventListener('pointerup', endPointer, { passive: true });
  overlay.canvas.addEventListener('pointercancel', endPointer, { passive: true });
  overlay.canvas.addEventListener('pointerleave', onPointerLeave, { passive: true });
  overlay.canvas.addEventListener('wheel', onWheel, { passive: false });
  overlay.canvas.addEventListener('dblclick', onDblClick);
  root.addEventListener('keydown', onKeyDown);

  // V8: Visibility change handler - invalidate caches when tab becomes visible
  // This fixes X-axis showing random hours after fullscreen toggle or tab switch
  const onVisibilityChange = () => {
    if (destroyed) return;
    if (document.visibilityState === 'visible') {
      // Force complete recalculation of all caches
      tickCoordinator.invalidateAll();
      clearGridCache();
      underlay.clearStabilization();
      seriesLayer.clearStabilization();
      overlay.clearStabilization();
      invalidate(InvalidationFlag.All);
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  applyWatermarkOptions(watermarkOptions);
  invalidate(InvalidationFlag.All);

  const normalizeSeriesMarkers = (
    markers: SeriesMarker[] | null | undefined,
  ): { markers: SeriesMarker[]; times: Float64Array | null } => {
    if (!Array.isArray(markers) || markers.length === 0) {
      return { markers: [], times: null };
    }
    const indexed: Array<{ marker: SeriesMarker; index: number }> = [];
    for (let i = 0; i < markers.length; i += 1) {
      const marker = markers[i];
      if (!marker) continue;
      const time = Number(marker.time);
      if (!Number.isFinite(time)) continue;
      indexed.push({ marker: { ...marker, time }, index: i });
    }
    if (indexed.length === 0) return { markers: [], times: null };
    indexed.sort((a, b) => (a.marker.time - b.marker.time) || (a.index - b.index));
    const ordered = indexed.map((entry) => entry.marker);
    const times = Float64Array.from(ordered.map((marker) => marker.time));
    return { markers: ordered, times };
  };

  const createSeriesHandle = (
    seriesOptions: LineSeriesOptions = {},
    seriesType: InternalSeries['seriesType'] = 'line',
    customRenderer: CustomSeriesRenderer<CanvasRenderingContext2D> | null = null,
  ): LineSeries => {
    const id = seriesOptions.id ?? `s${nextSeriesId++}`;
    const axis = resolveSeriesAxis(seriesOptions.axis);
    const paneId = resolveSeriesPane(seriesOptions.paneId);
    const internalOptions: LineSeriesOptions = {
      ...seriesOptions,
      axis,
      paneId,
      visible: seriesOptions.visible ?? true,
      lastValueVisible: seriesOptions.lastValueVisible ?? true,
      priceLineVisible: seriesOptions.priceLineVisible ?? false,
      priceLineStyle: seriesOptions.priceLineStyle ?? 'solid',
      priceLineSource: seriesOptions.priceLineSource ?? 'last',
      lastValueAnimation: seriesOptions.lastValueAnimation ?? false,
    };
    const internal: InternalSeries = {
      id,
      order: seriesList.length,
      seriesType,
      options: internalOptions,
      axis,
      paneId,
      data: new DataStore(),
      dataMode: 'static',
      provider: undefined,
      chunkLods: new Map(),
      ohlcData: null,
      ohlcLod: null,
      ohlcAxisBuckets: null,
      ohlcAxisBucketSize: 0,
      visible: internalOptions.visible ?? true,
      handle: null as unknown as LineSeries,
      lod: new LodPyramid(lodOptions),
      lodVersion: 0,
      lodBuildToken: null,
      dirtyRange: null,
      axisBuckets: null,
      axisBucketSize: 0,
      renderRevision: 0,
      crosshairCache: null,
      lastValue: null,
      lastValueText: '',
      lastValueColor: '',
      lastValueDisplay: null,
      lastValueAnimation: null,
      timeStepMs: null,
      timeStepSamples: [],
      lastTimeMs: null,
      scaleBase: null,
      markers: [],
      markerTimes: null,
      customRenderer,
    };

    const handle: LineSeries = {
      id,
      setData(points) {
        // V7 Fix: Populate timeBounds if empty so TimeScale works correctly
        if (timeBounds.length === 0 && points.length > 0) {
          timeBounds.setData(points);
        }
        ensureStaticSeries(internal);
        const store = internal.data as DataStore;
        store.setData(points);
        resetSeriesTimeStep(internal, store.times(), store.length);
        ensureAxisBuckets(internal);
        bumpSeriesRevision(internal);
        decimator.clearCache();
        chunkedDecimator.clearCache();
        resetLodState(internal);
        if (store.length >= LOD_ASYNC_THRESHOLD) {
          startLodBuild(internal);
        } else {
          withLodWork(() => internal.lod.rebuild(store.times(), store.values(), store.length));
        }
        syncTimeScaleToData();
        invalidate(InvalidationFlag.All);
      },
      append(point) {
        // V7 Fix: Populate timeBounds if empty
        if (timeBounds.length === 0) {
          timeBounds.append(point);
        }
        ensureStaticSeries(internal);
        const store = internal.data as DataStore;
        const prevLength = store.length;
        store.append(point);
        ensureAxisBuckets(internal);
        if (store.length > prevLength) {
          updateAxisBucketsForRange(internal, prevLength, store.length - 1);
        }
        extendSeriesTimeStepFromPoints(internal, [point]);
        bumpSeriesRevision(internal);
        decimator.clearCache();
        chunkedDecimator.clearCache();
        if (store.length > prevLength) {
          const shouldUpdateLod =
            internal.lod.levels.length > 0 || store.length < LOD_ASYNC_THRESHOLD;
          if (shouldUpdateLod) {
            withLodWork(() => internal.lod.append(store.times(), store.values(), store.length));
          }
        }
        syncTimeScaleToData();
        invalidate(InvalidationFlag.All);
      },
      appendBatch(points) {
        if (points.length === 0) return;
        // V7 Fix: Populate timeBounds if empty
        if (timeBounds.length === 0) {
          timeBounds.appendBatch(points);
        }
        ensureStaticSeries(internal);
        const store = internal.data as DataStore;
        const prevLength = store.length;
        store.appendBatch(points);
        ensureAxisBuckets(internal);
        if (store.length > prevLength) {
          updateAxisBucketsForRange(internal, prevLength, store.length - 1);
        }
        extendSeriesTimeStepFromPoints(internal, points);
        bumpSeriesRevision(internal);
        decimator.clearCache();
        chunkedDecimator.clearCache();
        if (store.length > prevLength) {
          const shouldUpdateLod =
            internal.lod.levels.length > 0 || store.length < LOD_ASYNC_THRESHOLD;
          if (shouldUpdateLod) {
            withLodWork(() =>
              internal.lod.appendBatch(store.times(), store.values(), prevLength, store.length),
            );
          }
        }
        syncTimeScaleToData();
        invalidate(InvalidationFlag.All);
      },
      patchExisting(points) {
        if (points.length === 0) return;
        const visibleRange = xScale.getVisibleRange();
        if (isChunkedStore(internal.data)) {
          const result = internal.data.patchExisting(points);
          if (!result) return;
          bumpSeriesRevision(internal);
          internal.lodVersion += 1;
          if (internal.lodBuildToken) {
            internal.lodBuildToken.canceled = true;
            internal.lodBuildToken = null;
          }
          const dirty = normalizeRange({ from: result.minTime, to: result.maxTime });
          mergeDirtyRange(internal, dirty);
          for (const startTime of result.chunks) {
            const entry = internal.chunkLods.get(startTime);
            if (entry) {
              releaseChunkLodEntry(entry);
              internal.chunkLods.delete(startTime);
            }
          }
          if (rangeIntersects(dirty, visibleRange)) {
            applyDirtyRange(internal, visibleRange);
            invalidate(InvalidationFlag.All);
          }
          return;
        }
        ensureStaticSeries(internal);
        const store = internal.data as DataStore;
        const result = store.patchExisting(points);
        if (!result) return;
        ensureAxisBuckets(internal);
        const startIndex = store.lowerBound(result.minTime);
        const endIndex = store.upperBound(result.maxTime) - 1;
        if (startIndex <= endIndex) {
          updateAxisBucketsForRange(internal, startIndex, endIndex);
        }
        bumpSeriesRevision(internal);
        internal.lodVersion += 1;
        if (internal.lodBuildToken) {
          internal.lodBuildToken.canceled = true;
          internal.lodBuildToken = null;
        }
        const dirty = normalizeRange({ from: result.minTime, to: result.maxTime });
        mergeDirtyRange(internal, dirty);
        if (rangeIntersects(dirty, visibleRange)) {
          applyDirtyRange(internal, visibleRange);
          invalidate(InvalidationFlag.All);
        }
      },
      updateLast(point) {
        ensureStaticSeries(internal);
        const store = internal.data as DataStore;
        const prevLength = store.length;
        store.updateLast(point);
        ensureAxisBuckets(internal);
        bumpSeriesRevision(internal);
        decimator.clearCache();
        chunkedDecimator.clearCache();
        const nextLength = store.length;
        if (nextLength > prevLength) {
          updateAxisBucketsForRange(internal, prevLength, nextLength - 1);
        } else if (nextLength > 0) {
          updateAxisBucketsForRange(internal, nextLength - 1, nextLength - 1);
        }
        if (nextLength > prevLength) {
          extendSeriesTimeStepFromPoints(internal, [point]);
          const shouldUpdateLod =
            internal.lod.levels.length > 0 || store.length < LOD_ASYNC_THRESHOLD;
          if (shouldUpdateLod) {
            withLodWork(() => internal.lod.append(store.times(), store.values(), nextLength));
          }
        } else {
          const shouldUpdateLod =
            internal.lod.levels.length > 0 || store.length < LOD_ASYNC_THRESHOLD;
          if (shouldUpdateLod) {
            withLodWork(() =>
              internal.lod.updateLast(store.times(), store.values(), nextLength),
            );
          }
        }
        syncTimeScaleToData();
        invalidate(InvalidationFlag.All);
      },
      setDataProvider(provider, options = {}) {
        detachProvider(internal);
        clearChunkLods(internal);
        clearAxisBuckets(internal);
        const outOfOrder = options.outOfOrder ?? 'reject';
        const duplicates = options.duplicates ?? (outOfOrder === 'drop' ? 'ignore' : 'reject');
        const nonFinite = options.nonFinite ?? 'allow';
        const providerOptions: DataProviderOptions = {
          ...options,
          outOfOrder,
          duplicates,
          nonFinite,
        };
        const chunkedOptions: ChunkedDataStoreOptions = {
          outOfOrder,
          duplicates,
          nonFinite,
        };
        if (typeof providerOptions.chunkSize === 'number') {
          chunkedOptions.chunkSize = providerOptions.chunkSize;
        }
        if (typeof providerOptions.maxChunks === 'number') {
          chunkedOptions.maxChunks = providerOptions.maxChunks;
        }
        if (typeof providerOptions.maxBytes === 'number') {
          chunkedOptions.maxBytes = providerOptions.maxBytes;
        }
        if (retainLodOnly) {
          chunkedOptions.onEvict = (chunk) => storeLodOnlyChunk(internal, chunk);
        }
        internal.data = new ChunkedDataStore(chunkedOptions);
        internal.dataMode = 'provider';
        resetLodState(internal);
        resetSeriesTimeStep(internal);
        const state: SeriesProviderState = {
          provider,
          options: providerOptions,
          loadedRange: null,
          pendingRange: null,
          requestId: 0,
          queue: [],
          scheduled: false,
          extents: null,
        };
        internal.provider = state;
        if (provider.subscribe) {
          state.unsubscribe = provider.subscribe((update) => enqueueProviderUpdate(internal, update));
        }
        if (provider.getExtents) {
          void provider.getExtents().then((extents) => {
            if (!internal.provider || internal.provider !== state) return;
            state.extents = extents;
            syncTimeScaleToData();
            invalidate(InvalidationFlag.All);
          });
        }
        bumpSeriesRevision(internal);
        decimator.clearCache();
        chunkedDecimator.clearCache();
        requestProviderRange(internal, xScale.getVisibleRange());
        invalidate(InvalidationFlag.All);
      },
      setMarkers(markers) {
        const normalized = normalizeSeriesMarkers(markers);
        internal.markers = normalized.markers;
        internal.markerTimes = normalized.times;
        invalidate(InvalidationFlag.Overlay);
      },
      setVisible(visible) {
        internal.visible = visible;
        internal.options.visible = visible;
        bumpSeriesRevision(internal);
        syncTimeScaleToData();
        invalidate(InvalidationFlag.All);
      },
      getVisible() {
        return internal.visible;
      },
    };

    internal.handle = handle;
    seriesList.push(internal);
    const seriesBucket = paneSeriesMap.get(paneId);
    if (seriesBucket) {
      seriesBucket.push(internal);
    } else {
      paneSeriesMap.set(paneId, [internal]);
    }

    return handle;
  };

  const chart: Chart = {
    addLineSeries(seriesOptions: LineSeriesOptions = {}): LineSeries {
      return createSeriesHandle(seriesOptions, 'line');
    },

    addCustomSeries<Ctx = unknown>(options: CustomSeriesOptions<Ctx>): CustomSeries {
      if (!options || typeof options.renderer !== 'object' || !options.renderer) {
        throw new Error('Custom series requires a renderer.');
      }
      const { renderer, ...lineOptions } = options as CustomSeriesOptions;
      return createSeriesHandle(
        lineOptions,
        'custom',
        renderer as CustomSeriesRenderer<CanvasRenderingContext2D>,
      ) as CustomSeries;
    },

    addCandlestickSeries(options: CandlestickSeriesOptions = {}): CandlestickSeries {
      const resolvedColor = options.color ?? options.upColor ?? options.downColor;
      const colorOverride =
        typeof resolvedColor === 'string' && resolvedColor.length > 0 ? resolvedColor : undefined;
      const line = createSeriesHandle(
        {
          ...options,
          ...(colorOverride ? { color: colorOverride } : {}),
        },
        'candlestick',
      );
      const internal = seriesList.find((series) => series.id === line.id);
      if (internal) {
        ensureOhlcPipeline(internal);
      }
      return {
        id: line.id,
        setData(points) {
          if (internal) {
            const store = ensureOhlcPipeline(internal);
            store.setData(points);
            ensureOhlcAxisBuckets(internal);
            ohlcDecimator.clearCache();
            rebuildOhlcLod(internal, store);
          }
          line.setData(mapOhlcPoints(points));
        },
        append(point) {
          if (internal) {
            const store = ensureOhlcPipeline(internal);
            const prevLength = store.length;
            store.append(point);
            ensureOhlcAxisBuckets(internal);
            const nextLength = store.length;
            if (nextLength > prevLength) {
              updateOhlcAxisBucketsForRange(internal, prevLength, nextLength - 1);
              appendOhlcLod(internal, store);
            } else if (nextLength > 0) {
              updateOhlcAxisBucketsForRange(internal, nextLength - 1, nextLength - 1);
              updateOhlcLodLast(internal, store);
            }
            ohlcDecimator.clearCache();
          }
          line.append(mapOhlcPoint(point));
        },
        appendBatch(points) {
          if (internal) {
            const store = ensureOhlcPipeline(internal);
            const prevLength = store.length;
            store.appendBatch(points);
            ensureOhlcAxisBuckets(internal);
            const nextLength = store.length;
            if (nextLength > prevLength) {
              updateOhlcAxisBucketsForRange(internal, prevLength, nextLength - 1);
              appendOhlcLodBatch(internal, store, prevLength);
            } else if (nextLength > 0) {
              updateOhlcAxisBucketsForRange(
                internal,
                Math.max(0, prevLength - 1),
                nextLength - 1,
              );
              updateOhlcLodLast(internal, store);
            }
            ohlcDecimator.clearCache();
          }
          line.appendBatch(mapOhlcPoints(points));
        },
        patchExisting(points) {
          if (internal) {
            const store = ensureOhlcPipeline(internal);
            const result = store.patchExisting(points);
            if (result) {
              ensureOhlcAxisBuckets(internal);
              const startIndex = store.lowerBound(result.minTime);
              const endIndex = store.upperBound(result.maxTime) - 1;
              if (startIndex <= endIndex) {
                updateOhlcAxisBucketsForRange(internal, startIndex, endIndex);
              }
              patchOhlcLod(internal, store, normalizeRange({ from: result.minTime, to: result.maxTime }));
              ohlcDecimator.clearCache();
            }
          }
          line.patchExisting(mapOhlcPoints(points));
        },
        updateLast(point) {
          if (internal) {
            const store = ensureOhlcPipeline(internal);
            const prevLength = store.length;
            store.updateLast(point);
            ensureOhlcAxisBuckets(internal);
            const nextLength = store.length;
            if (nextLength > prevLength) {
              updateOhlcAxisBucketsForRange(internal, prevLength, nextLength - 1);
              appendOhlcLod(internal, store);
            } else if (nextLength > 0) {
              updateOhlcAxisBucketsForRange(internal, nextLength - 1, nextLength - 1);
              updateOhlcLodLast(internal, store);
            }
            ohlcDecimator.clearCache();
          }
          line.updateLast(mapOhlcPoint(point));
        },
        setMarkers(markers) {
          line.setMarkers(markers);
        },
        setVisible(visible) {
          line.setVisible(visible);
        },
        getVisible() {
          return line.getVisible();
        },
      };
    },

    addBarSeries(options: BarSeriesOptions = {}): BarSeries {
      const resolvedColor = options.color ?? options.upColor ?? options.downColor;
      const colorOverride =
        typeof resolvedColor === 'string' && resolvedColor.length > 0 ? resolvedColor : undefined;
      const line = createSeriesHandle(
        {
          ...options,
          ...(colorOverride ? { color: colorOverride } : {}),
        },
        'bar',
      );
      const internal = seriesList.find((series) => series.id === line.id);
      if (internal) {
        ensureOhlcPipeline(internal);
      }
      return {
        id: line.id,
        setData(points) {
          if (internal) {
            const store = ensureOhlcPipeline(internal);
            store.setData(points);
            ensureOhlcAxisBuckets(internal);
            ohlcDecimator.clearCache();
            rebuildOhlcLod(internal, store);
          }
          line.setData(mapOhlcPoints(points));
        },
        append(point) {
          if (internal) {
            const store = ensureOhlcPipeline(internal);
            const prevLength = store.length;
            store.append(point);
            ensureOhlcAxisBuckets(internal);
            const nextLength = store.length;
            if (nextLength > prevLength) {
              updateOhlcAxisBucketsForRange(internal, prevLength, nextLength - 1);
              appendOhlcLod(internal, store);
            } else if (nextLength > 0) {
              updateOhlcAxisBucketsForRange(internal, nextLength - 1, nextLength - 1);
              updateOhlcLodLast(internal, store);
            }
            ohlcDecimator.clearCache();
          }
          line.append(mapOhlcPoint(point));
        },
        appendBatch(points) {
          if (internal) {
            const store = ensureOhlcPipeline(internal);
            const prevLength = store.length;
            store.appendBatch(points);
            ensureOhlcAxisBuckets(internal);
            const nextLength = store.length;
            if (nextLength > prevLength) {
              updateOhlcAxisBucketsForRange(internal, prevLength, nextLength - 1);
              appendOhlcLodBatch(internal, store, prevLength);
            } else if (nextLength > 0) {
              updateOhlcAxisBucketsForRange(
                internal,
                Math.max(0, prevLength - 1),
                nextLength - 1,
              );
              updateOhlcLodLast(internal, store);
            }
            ohlcDecimator.clearCache();
          }
          line.appendBatch(mapOhlcPoints(points));
        },
        patchExisting(points) {
          if (internal) {
            const store = ensureOhlcPipeline(internal);
            const result = store.patchExisting(points);
            if (result) {
              ensureOhlcAxisBuckets(internal);
              const startIndex = store.lowerBound(result.minTime);
              const endIndex = store.upperBound(result.maxTime) - 1;
              if (startIndex <= endIndex) {
                updateOhlcAxisBucketsForRange(internal, startIndex, endIndex);
              }
              patchOhlcLod(internal, store, normalizeRange({ from: result.minTime, to: result.maxTime }));
              ohlcDecimator.clearCache();
            }
          }
          line.patchExisting(mapOhlcPoints(points));
        },
        updateLast(point) {
          if (internal) {
            const store = ensureOhlcPipeline(internal);
            const prevLength = store.length;
            store.updateLast(point);
            ensureOhlcAxisBuckets(internal);
            const nextLength = store.length;
            if (nextLength > prevLength) {
              updateOhlcAxisBucketsForRange(internal, prevLength, nextLength - 1);
              appendOhlcLod(internal, store);
            } else if (nextLength > 0) {
              updateOhlcAxisBucketsForRange(internal, nextLength - 1, nextLength - 1);
              updateOhlcLodLast(internal, store);
            }
            ohlcDecimator.clearCache();
          }
          line.updateLast(mapOhlcPoint(point));
        },
        setMarkers(markers) {
          line.setMarkers(markers);
        },
        setVisible(visible) {
          line.setVisible(visible);
        },
        getVisible() {
          return line.getVisible();
        },
      };
    },

    addHistogramSeries(options: HistogramSeriesOptions = {}): HistogramSeries {
      const line = createSeriesHandle(options, 'histogram');
      const internal = seriesList.find((series) => series.id === line.id);
      return {
        id: line.id,
        setData(points) {
          line.setData(mapHistogramPoints(points));
          setHistogramColors(line.id, points, internal);
        },
        append(point) {
          line.append(mapHistogramPoint(point));
          updateHistogramColor(line.id, point, internal);
        },
        appendBatch(points) {
          line.appendBatch(mapHistogramPoints(points));
          for (const point of points) {
            updateHistogramColor(line.id, point, internal);
          }
        },
        patchExisting(points) {
          line.patchExisting(mapHistogramPoints(points));
          for (const point of points) {
            updateHistogramColor(line.id, point, internal);
          }
        },
        updateLast(point) {
          line.updateLast(mapHistogramPoint(point));
          updateHistogramColor(line.id, point, internal);
        },
        setMarkers(markers) {
          line.setMarkers(markers);
        },
        setVisible(visible) {
          line.setVisible(visible);
        },
        getVisible() {
          return line.getVisible();
        },
      };
    },

    addAreaSeries(options: AreaSeriesOptions = {}): AreaSeries {
      return createSeriesHandle(options, 'area') as AreaSeries;
    },

    addBaselineSeries(options: BaselineSeriesOptions = {}): BaselineSeries {
      return createSeriesHandle(options, 'baseline') as BaselineSeries;
    },

    getSeriesList(): LineSeries[] {
      return seriesList.map((series) => series.handle);
    },

    addPane(preserveEmptyPane?: boolean): PaneId {
      const id = `pane-${nextPaneId++}`;
      if (paneById.has(id)) {
        return id;
      }
      const pane = createPane(id, preserveEmptyPane ?? true);
      paneList.push(pane);
      paneById.set(id, pane);
      paneSeriesMap.set(id, []);
      invalidatePanCache();
      invalidate(InvalidationFlag.All);
      return id;
    },

    getPane(id: PaneId): PaneApi | null {
      const pane = paneById.get(id);
      return pane ? pane.handle : null;
    },

    getPanes(): PaneApi[] {
      return paneList.map((pane) => pane.handle);
    },

    batch(fn: () => void): void {
      runBatch(fn);
    },

    setAutoScroll(enabled: boolean): void {
      autoScrollEnabled = enabled;
      if (enabled) {
        hasCustomVisibleRange = true;
        syncTimeScaleToData();
      }
      invalidatePanCache();
      invalidate(InvalidationFlag.All);
    },

    addPlugin<Ctx>(plugin: ChartPlugin<Ctx>): void {
      const handle = plugin as ChartPlugin<CanvasRenderingContext2D>;
      plugins.push(handle);
      handle.onInit?.(chart);
      let flags = InvalidationFlag.None;
      if (handle.onRenderUnderlay) {
        flags = (flags | InvalidationFlag.Layout) as InvalidationFlag;
      }
      if (handle.onRenderOverlay) {
        flags = (flags | InvalidationFlag.Overlay) as InvalidationFlag;
      }
      if (flags === InvalidationFlag.None) {
        flags = InvalidationFlag.Overlay;
      }
      invalidate(flags);
    },

    exportPng(options?: ExportPngOptions): Promise<ExportPngResult> {
      return exportPng(options);
    },

    setAxisOptions(axis: AxisId, options: Parameters<PriceScale['setOptions']>[0]): void {
      axisOptions = { ...axisOptions, [axis]: { ...(axisOptions[axis] ?? {}), ...options } };
      for (const pane of paneList) {
        getAxisScale(pane.id, axis).setOptions(options);
      }
      labelCache.clear();
      cachedAxisWidthLeft = 0;
      cachedAxisWidthRight = 0;
      cachedAxisLabelSpacing = 0;
      invalidatePanCache();
      invalidate(InvalidationFlag.All);
    },

    setPaneAxisOptions(paneId: PaneId, axis: AxisId, options: Parameters<PriceScale['setOptions']>[0]): void {
      const pane = paneById.get(paneId);
      if (!pane) return;
      getAxisScale(paneId, axis).setOptions(options);
      labelCache.clear();
      // Reset width cache so it re-measures if needed
      if (axis === 'left') cachedAxisWidthLeft = 0;
      else cachedAxisWidthRight = 0;
      invalidatePanCache();
      invalidate(InvalidationFlag.All);
    },

    getAxisOptions(axis: AxisId): ReturnType<PriceScale['getOptions']> {
      return getAxisScale(defaultPaneId, axis).getOptions();
    },

    setGridOptions(options: Partial<GridOptions>): void {
      gridOptions = { ...gridOptions, ...options };
      // Force grid cache clear
      clearGridCache();
      invalidate(InvalidationFlag.Underlay);
    },

    getGridOptions(): GridOptions {
      return { ...gridOptions };
    },

    setVisibleTimeRange(range: VisibleTimeRange): void {
      if (autoScrollEnabled) {
        autoScrollEnabled = false;
      }
      xScale.setVisibleRange(normalizeRange(range));
      hasCustomVisibleRange = true;
      emitVisibleRangeChange();
      invalidate(InvalidationFlag.All);
    },

    getVisibleTimeRange(): VisibleTimeRange {
      return xScale.getVisibleRange();
    },

    onVisibleTimeRangeChange(cb: (range: VisibleTimeRange) => void): () => void {
      visibleRangeListeners.add(cb);
      return () => visibleRangeListeners.delete(cb);
    },

    setCrosshair(state: CrosshairState | null): void {
      if (!state) {
        pendingExternalCrosshair = null;
        externalCrosshair = null;
        crosshairActive = false;
        crosshairPaneId = null;
        crosshairTime = null;
        invalidate(InvalidationFlag.Overlay);
        return;
      }
      applyExternalCrosshair(state, true);
    },

    onCrosshairMove(cb: (event: CrosshairMoveEvent) => void): () => void {
      crosshairListeners.add(cb);
      return () => crosshairListeners.delete(cb);
    },

    setCrosshairMode(mode: CrosshairMode): void {
      crosshairMode = mode;
      if (hasPointerPosition && crosshairActive && !externalCrosshair && isInsidePlot(lastPointerX, lastPointerY)) {
        updateCrosshairState(lastPointerX, lastPointerY, false);
        if (crosshairActive) {
          pendingCrosshairEmit = true;
        }
      }
      invalidate(InvalidationFlag.Overlay);
    },

    setTheme(next: ThemeTokensInput): void {
      theme = normalizeThemeTokens(next, theme);
      paint = compileTheme(theme);
      themeVersion += 1;
      labelCache.clear();
      axisPillWidthLeft = 0;
      axisPillWidthRight = 0;
      cachedAxisWidthLeft = 0;
      cachedAxisWidthRight = 0;
      cachedAxisLabelSpacing = 0;
      cachedTimeLabelWidth = 0;
      cachedTimeTicks = null;
      // V7: Clear axis width shrink timers on destroy
      if (axisWidthShrinkTimerLeft !== null) {
        window.clearTimeout(axisWidthShrinkTimerLeft);
        axisWidthShrinkTimerLeft = null;
      }
      if (axisWidthShrinkTimerRight !== null) {
        window.clearTimeout(axisWidthShrinkTimerRight);
        axisWidthShrinkTimerRight = null;
      }
      pendingShrinkWidthLeft = null;
      pendingShrinkWidthRight = null;
      clearPathCache();
      invalidatePanCache();
      invalidate(InvalidationFlag.All);
    },

    setWatermark(options: WatermarkOptions | null): void {
      applyWatermarkOptions(options);
    },

    addIndicator(options: any): any {
      // V6: Indicator API stub - Full implementation requires complex data type handling
      // For now, return a stub that allows manual indicator creation via addLineSeries
      const indicatorId = options.id ?? `indicator-${nextSeriesId++}`;
      console.warn('Indicator API is a stub. Use addLineSeries to manually add indicator lines.');

      return {
        id: indicatorId,
        type: options.type,
        series: [],
        remove() { },
        update() { },
        setVisible() { },
      };
    },

    removeIndicator(indicatorId: string): void {
      // V6: Indicator API stub
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      overlay.canvas.removeEventListener('pointerdown', onPointerDown);
      overlay.canvas.removeEventListener('pointermove', onPointerMove);
      if (supportsPointerRawUpdate) {
        overlay.canvas.removeEventListener('pointerrawupdate', onPointerMove);
      }
      overlay.canvas.removeEventListener('pointerup', endPointer);
      overlay.canvas.removeEventListener('pointercancel', endPointer);
      overlay.canvas.removeEventListener('pointerleave', onPointerLeave);
      overlay.canvas.removeEventListener('wheel', onWheel);
      root.removeEventListener('keydown', onKeyDown);
      // V8: Remove visibility change listener on destroy
      document.removeEventListener('visibilitychange', onVisibilityChange);
      ro?.disconnect();
      // V7: Remove DPR change listener on destroy
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', checkDprChange);
      }
      seriesList.forEach((series) => {
        if (series.lodBuildToken) {
          series.lodBuildToken.canceled = true;
          series.lodBuildToken = null;
        }
        detachProvider(series);
      });
      seriesList.length = 0;
      histogramColorBySeries.clear();
      panCaches.clear();
      axisSmoothing.clear();
      lodRequests.clear();
      lodRequestTimes.clear();
      chunkLodRequests.clear();
      chunkLodRequestTimes.clear();
      lodWorkerTotalMs = 0;
      lodWorkerCompleted = 0;
      chunkLodWorkerTotalMs = 0;
      chunkLodWorkerCompleted = 0;
      if (lodWorker) {
        lodWorker.terminate();
        lodWorker = null;
      }
      if (seriesWorker) {
        seriesWorker.terminate();
        seriesWorker = null;
      }
      seriesWorkerActive = false;
      plugins.length = 0;
      crosshairListeners.clear();
      visibleRangeListeners.clear();
      scheduler.destroy();
      clearElasticIdleTimer();
      cancelElasticReturn();
      if (interactionTimer !== null && typeof window !== 'undefined') {
        window.clearTimeout(interactionTimer);
        interactionTimer = null;
      }
      if (wheelPanEndHandle !== null && typeof window !== 'undefined') {
        window.clearTimeout(wheelPanEndHandle);
        wheelPanEndHandle = null;
      }
      // V7: Clear axis width shrink timers on destroy
      if (axisWidthShrinkTimerLeft !== null && typeof window !== 'undefined') {
        window.clearTimeout(axisWidthShrinkTimerLeft);
        axisWidthShrinkTimerLeft = null;
      }
      if (axisWidthShrinkTimerRight !== null && typeof window !== 'undefined') {
        window.clearTimeout(axisWidthShrinkTimerRight);
        axisWidthShrinkTimerRight = null;
      }
      runtimeHandle.destroy();
      underlay.destroy();
      seriesLayer.destroy();
      panLayer.destroy();
      overlay.destroy();
      cancelInertia();
      if (logTimer !== null) {
        window.clearInterval(logTimer);
        logTimer = null;
      }
    },
  };

  const debugApi = {
    readRenderStats,
    resetRenderStats: () => readRenderStats(true),
    readWorkerStats,
    getSeriesLodInfo: () =>
      seriesList.map((series) => ({
        id: series.id,
        levelCount: series.lod.levels.length,
        levels: series.lod.levels.map((level) => ({
          bucketSize: level.bucketSize,
          length: level.length,
        })),
        building: series.lodBuildToken !== null,
      })),
    getChunkLodInfo: () =>
      seriesList.map((series) => ({
        id: series.id,
        chunks: Array.from(series.chunkLods.entries()).map(([startTime, entry]) => ({
          startTime,
          endTime: entry.endTime,
          length: entry.length,
          levelCount: entry.lod.levels.length,
          levels: entry.lod.levels.map((level) => ({
            bucketSize: level.bucketSize,
            length: level.length,
          })),
          pendingWorker: entry.pendingRequestId !== null,
          pendingBuild: entry.pendingBuildToken !== null,
        })),
      })),
    getSeriesDataInfo: () =>
      seriesList.map((series) => {
        if (isChunkedStore(series.data)) {
          return {
            id: series.id,
            mode: 'chunked' as const,
            length: series.data.length,
            chunks: series.data.chunkCount,
            bytesUsed: series.data.bytesUsed,
          };
        }
        return {
          id: series.id,
          mode: 'static' as const,
          length: series.data.length,
          chunks: 0,
          bytesUsed: null,
        };
      }),
    getSeriesRendererInfo: () => ({
      requested: seriesRendererMode,
      active: seriesWorkerActive ? 'worker' : 'main',
      supported: seriesWorkerSupported,
    }),
    getAllocationStats: () => ({
      line: decimator.getAllocationStats(),
      ohlc: ohlcDecimator.getAllocationStats(),
      chunked: chunkedDecimator.getAllocationStats(),
    }),
    getLineRenderMode: () => lineRenderMode,
    getAxisRanges: () =>
      paneStates.map((paneState) => {
        const left = getAxisScale(paneState.id, 'left');
        const right = getAxisScale(paneState.id, 'right');
        const leftRange = left.getRange();
        const rightRange = right.getRange();
        return {
          id: paneState.id,
          left: { ...leftRange, minPositive: left.getMinPositive() },
          right: { ...rightRange, minPositive: right.getMinPositive() },
        };
      }),
    getPanCacheState: () => ({
      active: panCacheActive,
      seriesHidden: seriesLayerHidden,
      panActive,
    }),
    getCrosshairState: () => {
      if (!layoutState || !crosshairActive) return null;
      const plotRect = layoutState.plotRect;
      return {
        x: crosshairX,
        y: crosshairY,
        paneId: crosshairPaneId ?? defaultPaneId,
        time: crosshairTime ?? xScale.xToTime(crosshairX - plotRect.x),
      };
    },
    getLayout: () =>
      layoutState
        ? {
          chartRect: cloneRect(layoutState.chartRect)!,
          plotRect: cloneRect(layoutState.plotRect)!,
          leftAxisRect: cloneRect(layoutState.leftAxisRect),
          rightAxisRect: cloneRect(layoutState.rightAxisRect),
          panes: layoutState.panes ? layoutState.panes.map(clonePaneLayout) : undefined,
        }
        : null,
    getFrameTimingStats: () => frameTimingMonitor.getStats(),
    resetFrameTimingStats: () => frameTimingMonitor.reset(),
    setFrameTimingEnabled: (enabled: boolean) => frameTimingMonitor.setEnabled(enabled),
  };
  (chart as Chart & { __chartsPlusDebug?: typeof debugApi }).__chartsPlusDebug = debugApi;

  return chart;
}

export function createYieldCurveChart(
  container: HTMLElement | string,
  options: YieldCurveChartOptions = {},
): Chart {
  const scaleOptions = resolveNumericScaleOptions(options, { tickSteps: DEFAULT_YIELD_TICK_STEPS });
  const { xFormatter, timeFormatter, xScale: _xScale, ...chartOptions } = options;
  const resolvedFormatter = timeFormatter ?? xFormatter ?? formatTenorMonths;
  const overrides: ChartFactoryOverrides = {
    createScale: (data, range) => new NumericScale(data, range, scaleOptions),
  };
  return createChart(container, { ...chartOptions, timeFormatter: resolvedFormatter }, overrides);
}

export function createOptionsChart(
  container: HTMLElement | string,
  options: OptionsChartOptions = {},
): Chart {
  const scaleOptions = resolveNumericScaleOptions(options);
  const { xFormatter, timeFormatter, xScale: _xScale, ...chartOptions } = options;
  const resolvedFormatter = timeFormatter ?? xFormatter ?? ((value: number) => formatNumericValue(value, 2));
  const overrides: ChartFactoryOverrides = {
    createScale: (data, range) => new NumericScale(data, range, scaleOptions),
  };
  return createChart(container, { ...chartOptions, timeFormatter: resolvedFormatter }, overrides);
}

export { CanvasSurface } from './canvas-surface';
export { createSyncGroup } from './sync-group';
