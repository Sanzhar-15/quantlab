import {
  createChart as createCanvasChart,
  createOptionsChart,
  createSyncGroup,
  createYieldCurveChart,
} from '@charts-plus/chart-render-canvas2d';
import '@charts-plus/chart-render-canvas2d/worker';
import {
  type AxisId,
  type Chart,
  type ChartPlugin,
  type CrosshairMode,
  type CustomSeriesRenderer,
  type DataPoint,
  type OhlcDataPoint,
  type ExportPngOptions,
  type LayoutResult,
  type LineSeries,
  type SeriesColorToken,
  type SeriesRendererMode,
  type ThemeTokens,
  type VisibleTimeRange,
} from '@charts-plus/chart-core';
import { getThemePreset } from '@charts-plus/chart-core/presets';
import { ColorType, LineSeries, createChart as createTvChart } from 'lightweight-charts';

const root = document.getElementById('chart');

const darkTheme = getThemePreset('atlas-dark');
const neutralTheme = getThemePreset('atlas-neutral');
const lightTheme = getThemePreset('atlas-light');

const applyPageTheme = (theme: ThemeTokens) => {
  if (!root) return;
  const isLight = theme === lightTheme;
  const isNeutral = theme === neutralTheme;
  const background = isLight ? '#f2ede4' : isNeutral ? '#141824' : '#0a0f18';
  document.body.style.background = background;
  document.documentElement.style.background = background;
  root.style.borderColor = isLight
    ? 'rgba(24, 32, 47, 0.18)'
    : isNeutral
      ? 'rgba(255, 255, 255, 0.1)'
      : 'rgba(255, 255, 255, 0.14)';
};

const buildWaveSeries = (
  start: number,
  count: number,
  stepMs: number,
  base: number,
  amplitude: number,
  gapEvery = 0,
  phase = 0,
): DataPoint[] => {
  const points: DataPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = start + i * stepMs;
    if (gapEvery > 0 && i % gapEvery === 0) {
      points.push({ t, v: null });
      continue;
    }
    const wave =
      Math.sin(i / 12 + phase) * amplitude + Math.cos(i / 7 + phase) * (amplitude * 0.4);
    const drift = Math.sin(i / 48 + phase) * (amplitude * 0.25);
    points.push({ t, v: base + wave + drift });
  }
  return points;
};

const buildOhlcSeries = (
  start: number,
  count: number,
  stepMs: number,
  base: number,
  amplitude: number,
  seed = 0x1a2b3c4d,
): OhlcDataPoint[] => {
  const rng = mulberry32(seed);
  const phase = rng() * Math.PI * 2;
  const points: OhlcDataPoint[] = [];
  let prevClose = base;
  for (let i = 0; i < count; i += 1) {
    const t = start + i * stepMs;
    const wave = Math.sin(i / 16 + phase) * amplitude + Math.cos(i / 27 + phase) * (amplitude * 0.45);
    const drift = Math.sin(i / 58 + phase) * (amplitude * 0.2);
    const target = base + wave + drift;
    const open = prevClose;
    const close = target + (rng() - 0.5) * amplitude * 0.3;
    const wick = Math.abs((rng() - 0.5) * amplitude * 0.7);
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    points.push({ t, o: open, h: high, l: low, c: close });
    prevClose = close;
  }
  return points;
};

const buildYieldCurveSeries = (
  tenors: number[],
  base: number,
  slope: number,
  curvature: number,
  phase = 0,
): DataPoint[] =>
  tenors.map((tenor) => {
    const scaled = Math.log1p(tenor / 12);
    const wiggle = Math.sin(tenor / 18 + phase) * curvature;
    return { t: tenor, v: base + slope * scaled + wiggle };
  });

const buildOptionsSmileSeries = (
  strikes: number[],
  center: number,
  baseVol: number,
  skew: number,
  smile: number,
): DataPoint[] =>
  strikes.map((strike) => {
    const offset = (strike - center) / center;
    return { t: strike, v: baseVol + skew * offset + smile * offset * offset };
  });

const createCustomSeriesRenderer = (): CustomSeriesRenderer<CanvasRenderingContext2D> => ({
  draw(ctx, state) {
    const { time, value, length } = state.data;
    const count = Math.min(length, time.length, value.length);
    if (count === 0) return;

    const color = state.options.color ?? state.theme.seriesPrimary;
    const baseOpacity = Math.max(0, Math.min(1, state.options.opacity ?? 1));
    const lineWidth = state.alignLineWidth(Math.max(1, state.options.width ?? 2));
    const glowWidth = state.alignLineWidth(Math.max(2, lineWidth * 2.2));
    const dash = state.options.dash ?? [];
    const renderMode = state.renderMode;
    const gapThresholdMs =
      typeof state.gapThresholdMs === 'number' && Number.isFinite(state.gapThresholdMs)
        ? state.gapThresholdMs
        : null;

    const tracePath = (
      target: Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo'>,
      snapWidth: number,
    ): boolean => {
      let started = false;
      let prevY = 0;
      let prevTime = Number.NaN;
      let hasStroke = false;

      for (let i = 0; i < count; i += 1) {
        const v = value[i];
        if (!Number.isFinite(v)) {
          started = false;
          prevTime = Number.NaN;
          continue;
        }
        const t = time[i];
        if (
          started &&
          gapThresholdMs !== null &&
          Number.isFinite(prevTime) &&
          t - prevTime > gapThresholdMs
        ) {
          started = false;
        }
        const x = state.snapX(state.timeToX(t), snapWidth);
        const y = state.snapY(state.valueToY(v), snapWidth);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          started = false;
          prevTime = Number.NaN;
          continue;
        }
        if (!started) {
          target.moveTo(x, y);
          started = true;
          hasStroke = true;
        } else if (renderMode === 'step') {
          target.lineTo(x, prevY);
          target.lineTo(x, y);
        } else {
          target.lineTo(x, y);
        }
        prevY = y;
        prevTime = t;
      }
      return hasStroke;
    };

    const hasPathSupport = typeof Path2D !== 'undefined';
    const path = hasPathSupport ? new Path2D() : null;
    const hasStroke = path ? tracePath(path, lineWidth) : false;

    const strokePath = (width: number, alpha: number, dashed: boolean) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = baseOpacity * alpha;
      ctx.setLineDash(dashed && dash.length > 0 ? dash : []);
      if (path && hasStroke) {
        ctx.stroke(path);
      } else {
        ctx.beginPath();
        const drawn = tracePath(ctx, width);
        if (drawn) {
          ctx.stroke();
        }
      }
      ctx.restore();
    };

    strokePath(glowWidth, 0.25, false);
    strokePath(lineWidth, 0.95, true);

    const dotStride = Math.max(10, Math.round(count / 26));
    const dotRadius = Math.max(2, lineWidth * 1.1);
    const haloRadius = dotRadius * 2.3;
    ctx.save();
    ctx.fillStyle = color;
    for (let i = 0; i < count; i += dotStride) {
      const v = value[i];
      if (!Number.isFinite(v)) continue;
      const t = time[i];
      const x = state.snapX(state.timeToX(t), lineWidth);
      const y = state.snapY(state.valueToY(v), lineWidth);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      ctx.globalAlpha = baseOpacity * 0.2;
      ctx.beginPath();
      ctx.arc(x, y, haloRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = baseOpacity * 0.9;
      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  },
});

type Annotation = {
  time: number;
  label: string;
  color?: string;
};

type RangeBandOptions = {
  min: number;
  max: number;
  color?: string;
  opacity?: number;
  label?: string;
};

const createAnnotationPlugin = (
  annotations: Annotation[],
): ChartPlugin<CanvasRenderingContext2D> => ({
  onRenderOverlay(ctx, state) {
    if (annotations.length === 0) return;
    const fontSize = Math.max(10, Math.round(state.theme.fontSizePx));
    const font = `${fontSize}px ${state.theme.fontFamily}`;
    const padding = 6;
    const lineHeight = fontSize + padding;
    const minTime = state.visibleRange.from;
    const maxTime = state.visibleRange.to;

    ctx.save();
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    annotations.forEach((annotation) => {
      if (annotation.time < minTime || annotation.time > maxTime) return;
      const x = state.timeToX(annotation.time);
      if (!Number.isFinite(x)) return;
      const snappedX = state.snapX(x);
      const color = annotation.color ?? state.theme.crosshair;
      if (snappedX < state.plotRect.x || snappedX > state.plotRect.x + state.plotRect.width) return;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(snappedX, state.plotRect.y);
      ctx.lineTo(snappedX, state.plotRect.y + state.plotRect.height);
      ctx.stroke();

      const textWidth = ctx.measureText(annotation.label).width;
      const boxWidth = textWidth + padding * 2;
      let labelX = snappedX - boxWidth * 0.5;
      const minX = state.plotRect.x + 2;
      const maxX = state.plotRect.x + state.plotRect.width - boxWidth - 2;
      labelX = Math.max(minX, Math.min(labelX, maxX));
      const labelY = state.plotRect.y + 6;

      ctx.globalAlpha = 0.9;
      ctx.fillStyle = state.theme.background;
      ctx.fillRect(labelX, labelY, boxWidth, lineHeight);

      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fillText(annotation.label, labelX + padding, labelY + padding * 0.5);
    });

    ctx.restore();
  },
});

const createRangeBandPlugin = (
  options: RangeBandOptions,
): ChartPlugin<CanvasRenderingContext2D> => ({
  onRenderUnderlay(ctx, state) {
    const min = Math.min(options.min, options.max);
    const max = Math.max(options.min, options.max);
    const topValue = state.valueToY(max);
    const bottomValue = state.valueToY(min);
    if (!Number.isFinite(topValue) || !Number.isFinite(bottomValue)) return;

    const top = Math.max(state.plotRect.y, Math.min(topValue, bottomValue));
    const bottom = Math.min(
      state.plotRect.y + state.plotRect.height,
      Math.max(topValue, bottomValue),
    );
    const height = bottom - top;
    if (height <= 0) return;

    ctx.save();
    ctx.globalAlpha = options.opacity ?? 0.15;
    ctx.fillStyle = options.color ?? state.theme.focusBand;
    ctx.fillRect(state.plotRect.x, top, state.plotRect.width, height);
    ctx.restore();
  },
  onRenderOverlay(ctx, state) {
    if (!options.label) return;
    const fontSize = Math.max(10, Math.round(state.theme.fontSizePx));
    const font = `${fontSize}px ${state.theme.fontFamily}`;
    const padding = 6;
    ctx.save();
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textWidth = ctx.measureText(options.label).width;
    const boxWidth = textWidth + padding * 2;
    const boxHeight = fontSize + padding;
    const x = state.plotRect.x + 8;
    const y = state.plotRect.y + 8;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = state.theme.background;
    ctx.fillRect(x, y, boxWidth, boxHeight);
    ctx.globalAlpha = 1;
    ctx.fillStyle = state.theme.axisText;
    ctx.fillText(options.label, x + padding, y + boxHeight * 0.5);
    ctx.restore();
  },
});

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

type ScenarioKey =
  | 'SCENARIO_A'
  | 'SCENARIO_B'
  | 'SCENARIO_C'
  | 'SCENARIO_D'
  | 'SCENARIO_E'
  | 'SCENARIO_F';
type ChartLibrary = 'charts-plus' | 'lightweight';
type TvChart = ReturnType<typeof createTvChart>;
type TvSeriesPoint = { time: number; value?: number };

type ScenarioConfig = {
  seriesCount: number;
  points: number;
  baseStepMs: number;
  jitterMs: number;
  gapEvery: number;
};

type ScenarioMeta = {
  name: ScenarioKey;
  seriesCount: number;
  pointsPerSeries: number;
  seed: number;
  baseStepMs: number;
  jitterMs: number;
  gapEvery: number;
  startTime: number;
  endTime: number;
  visibleFrom: number;
  visibleTo: number;
  chartCount?: number;
  visibleCharts?: number;
  streaming?: {
    pointsPerSecond: number;
    durationMs: number;
    batchSize: number;
    batchIntervalMs: number;
  };
};

type ScenarioSeries = {
  preset: SeriesPreset;
  points: DataPoint[];
};

type ScenarioData = {
  meta: ScenarioMeta;
  series: ScenarioSeries[];
};

type SeriesPreset = {
  id: string;
  colorKey: SeriesColorToken;
  base: number;
  amplitude: number;
  seed: number;
  dash?: number[];
  opacity?: number;
};

const scenarioConfigs: Record<ScenarioKey, ScenarioConfig> = {
  SCENARIO_A: {
    seriesCount: 3,
    points: 10_000,
    baseStepMs: 60_000,
    jitterMs: 45_000,
    gapEvery: 67,
  },
  SCENARIO_B: {
    seriesCount: 2,
    points: 200_000,
    baseStepMs: 60_000,
    jitterMs: 30_000,
    gapEvery: 113,
  },
  SCENARIO_C: {
    seriesCount: 1,
    points: 2_000_000,
    baseStepMs: 60_000,
    jitterMs: 30_000,
    gapEvery: 0,
  },
  SCENARIO_D: {
    seriesCount: 10,
    points: 2_000_000,
    baseStepMs: 60_000,
    jitterMs: 55_000,
    gapEvery: 0,
  },
  SCENARIO_E: {
    seriesCount: 1,
    points: 50_000,
    baseStepMs: 1_000,
    jitterMs: 250,
    gapEvery: 0,
  },
  SCENARIO_F: {
    seriesCount: 1,
    points: 200_000,
    baseStepMs: 60_000,
    jitterMs: 20_000,
    gapEvery: 0,
  },
};

const scenarioSeeds: Record<ScenarioKey, number> = {
  SCENARIO_A: 0x19a2d3f5,
  SCENARIO_B: 0x8f5a1c44,
  SCENARIO_C: 0x4c7a9e1b,
  SCENARIO_D: 0x71a2b3c4,
  SCENARIO_E: 0x2e8f4a19,
  SCENARIO_F: 0x63d9c7aa,
};

const scenarioPresets: SeriesPreset[] = [
  { id: 'Alpha', colorKey: 'seriesPrimary', base: 112, amplitude: 7, seed: 0x1a2b3c4d },
  {
    id: 'Beta',
    colorKey: 'seriesSecondary',
    base: 126,
    amplitude: 6,
    seed: 0x22334455,
    dash: [6, 4],
    opacity: 0.9,
  },
  { id: 'Gamma', colorKey: 'seriesTertiary', base: 98, amplitude: 8, seed: 0xdeadbeef },
  { id: 'Delta', colorKey: 'seriesQuaternary', base: 140, amplitude: 5, seed: 0x13579bdf },
  {
    id: 'Epsilon',
    colorKey: 'seriesQuinary',
    base: 122,
    amplitude: 5,
    seed: 0x2468ace0,
    opacity: 0.85,
  },
  {
    id: 'Zeta',
    colorKey: 'seriesPrimary',
    base: 108,
    amplitude: 6,
    seed: 0xbeadface,
    dash: [4, 3],
    opacity: 0.8,
  },
  { id: 'Eta', colorKey: 'seriesSecondary', base: 134, amplitude: 5, seed: 0x10203040 },
  {
    id: 'Theta',
    colorKey: 'seriesTertiary',
    base: 100,
    amplitude: 7,
    seed: 0xa5a5a5a5,
    dash: [2, 3],
    opacity: 0.85,
  },
  {
    id: 'Iota',
    colorKey: 'seriesQuaternary',
    base: 146,
    amplitude: 4,
    seed: 0x55aa55aa,
    opacity: 0.82,
  },
  {
    id: 'Kappa',
    colorKey: 'seriesQuinary',
    base: 116,
    amplitude: 6,
    seed: 0x0f1e2d3c,
    dash: [5, 4],
    opacity: 0.9,
  },
];

const buildIrregularTimes = (
  count: number,
  start: number,
  baseStepMs: number,
  jitterMs: number,
  rng: () => number,
): Float64Array => {
  const times = new Float64Array(count);
  let time = start;
  for (let i = 0; i < count; i += 1) {
    const jitter = Math.round((rng() - 0.5) * jitterMs * 2);
    const step = Math.max(1, baseStepMs + jitter);
    time += step;
    times[i] = time;
  }
  return times;
};

const buildSeriesPoints = (
  times: Float64Array,
  preset: SeriesPreset,
  gapEvery: number,
  seed: number,
): DataPoint[] => {
  const rng = mulberry32(seed);
  const phase = rng() * Math.PI * 2;
  const points = new Array<DataPoint>(times.length);
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i]!;
    if (gapEvery > 0 && i % gapEvery === 0) {
      points[i] = { t, v: null };
      continue;
    }
    const wave =
      Math.sin(i / 18 + phase) * preset.amplitude +
      Math.cos(i / 31 + phase) * (preset.amplitude * 0.4);
    const noise = (rng() - 0.5) * preset.amplitude * 0.35;
    points[i] = { t, v: preset.base + wave + noise };
  }
  return points;
};

const buildScenario = (scenario: ScenarioKey): ScenarioData => {
  const config = scenarioConfigs[scenario];
  const seed = scenarioSeeds[scenario];
  const rng = mulberry32(seed);
  const start = Date.UTC(2023, 0, 2, 9, 0, 0);
  const times = buildIrregularTimes(
    config.points,
    start,
    config.baseStepMs,
    config.jitterMs,
    rng,
  );

  const series = scenarioPresets.slice(0, config.seriesCount).map((preset, index) => ({
    preset,
    points: buildSeriesPoints(times, preset, config.gapEvery, preset.seed + index * 17 + seed),
  }));

  const endTime = times[times.length - 1]!;
  const span = endTime - times[0]!;
  const windowSpan = Math.max(config.baseStepMs * 240, span * 0.1);
  const visibleFrom = endTime - windowSpan;

  return {
    meta: {
      name: scenario,
      seriesCount: config.seriesCount,
      pointsPerSeries: config.points,
      seed,
      baseStepMs: config.baseStepMs,
      jitterMs: config.jitterMs,
      gapEvery: config.gapEvery,
      startTime: times[0]!,
      endTime,
      visibleFrom,
      visibleTo: endTime,
    },
    series,
  };
};

const resolveThemeColor = (token: SeriesColorToken): string => darkTheme[token];

const buildTradingViewSeriesData = (points: DataPoint[]): TvSeriesPoint[] =>
  points.map((point) => {
    const time = Math.floor(point.t / 1000);
    if (point.v === null) return { time };
    return { time, value: point.v };
  });

const createTradingViewChart = () => {
  if (!root) return null;
  const rect = root.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  const chart = createTvChart(root, {
    width,
    height,
    layout: {
      background: { type: ColorType.Solid, color: darkTheme.background },
      textColor: darkTheme.axisText,
      fontFamily: darkTheme.fontFamily,
      fontSize: darkTheme.fontSizePx,
    },
    grid: {
      vertLines: { color: darkTheme.gridMinor },
      horzLines: { color: darkTheme.gridMajor },
    },
    crosshair: {
      vertLine: { color: darkTheme.crosshair },
      horzLine: { color: darkTheme.crosshair },
    },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false },
  });

  const resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          const next = root.getBoundingClientRect();
          chart.applyOptions({
            width: Math.max(1, Math.round(next.width)),
            height: Math.max(1, Math.round(next.height)),
          });
        })
      : null;

  resizeObserver?.observe(root);

  return { chart, resizeObserver };
};

const applyScenarioToTradingView = (target: TvChart, scenario: ScenarioKey): ScenarioMeta => {
  applyPageTheme(darkTheme);

  const data = buildScenario(scenario);
  scenarioData = data;
  data.series.forEach(({ preset, points }) => {
    const color = resolveThemeColor(preset.colorKey);
    const series =
      typeof (target as { addLineSeries?: (options: { color: string; lineWidth: number }) => any })
        .addLineSeries === 'function'
        ? (target as { addLineSeries: (options: { color: string; lineWidth: number }) => any }).addLineSeries({
            color,
            lineWidth: 2,
          })
        : (
            target as {
              addSeries: (seriesType: unknown, options: { color: string; lineWidth: number }) => any;
            }
          ).addSeries(LineSeries, {
            color,
            lineWidth: 2,
          });
    series.setData(buildTradingViewSeriesData(points));
  });

  target.timeScale().setVisibleRange({
    from: Math.floor(data.meta.visibleFrom / 1000),
    to: Math.floor(data.meta.visibleTo / 1000),
  });

  return data.meta;
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
  memory?: {
    heap?: { used: number | null; total: number | null; limit: number | null };
    workingSet?: { bytes: number | null; measuredAt: number | null };
  };
};
type AllocationStats = { frame: number; total: number; pooled: number };
type DecimatorAllocationStats = { line: AllocationStats; chunked: AllocationStats };
type CrosshairSnapshot = {
  time: number;
  x: number;
  y: number;
  seriesValues: Array<{ id: string; value: number | null; formatted: string }>;
};
type SeriesRendererInfo = {
  requested: SeriesRendererMode;
  active: 'main' | 'worker';
  supported: boolean;
};
type WorkerQueueStats = { queueDepth: number; totalMs: number; completed: number };
type WorkerStats = { lod: WorkerQueueStats; chunkLod: WorkerQueueStats };

type InputLatencySamples = {
  pointerMove: number[];
  drag: number[];
  wheel: number[];
};

type HeapSample = {
  t: number;
  used: number | null;
  total: number | null;
  limit: number | null;
};

type WorkingSetSample = {
  t: number;
  bytes: number | null;
};

type MemorySamples = {
  heap: { intervalMs: number; samples: HeapSample[] };
  workingSet: { intervalMs: number; samples: WorkingSetSample[] };
};

type PerfSample = {
  frameTimes: number[];
  longTasks: number[];
  inputLatency: InputLatencySamples;
  eventTiming: InputLatencySamples;
  memory: MemorySamples;
  renderStats: RenderStats;
  workerStats: WorkerStats;
  allocationStats: DecimatorAllocationStats;
  sampleWindow: { start: number; end: number; durationMs: number };
};

type EnvironmentMeta = {
  userAgent: string;
  platform: string;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  dpr: number;
  locale: string;
  timeZone: string;
  cpuClass: 'low' | 'medium' | 'high' | 'unknown';
  uaBrands?: string[];
  mobile?: boolean;
};

const readRenderStats = (chart: Chart | null, reset = false): RenderStats => {
  if (!chart) {
    return { frames: 0, layout: 0, series: 0, overlay: 0 };
  }
  const debug = chart as Chart & {
    __chartsPlusDebug?: {
      readRenderStats?: (reset?: boolean) => RenderStats;
      resetRenderStats?: () => void;
      getSeriesRendererInfo?: () => SeriesRendererInfo;
      getAllocationStats?: () => AllocationStats;
      getLayout?: () => LayoutResult | null;
      readWorkerStats?: (reset?: boolean) => WorkerStats;
    };
  };
  if (debug.__chartsPlusDebug?.readRenderStats) {
    return debug.__chartsPlusDebug.readRenderStats(reset);
  }
  return { frames: 0, layout: 0, series: 0, overlay: 0 };
};

const readWorkerStats = (chart: Chart | null, reset = false): WorkerStats => {
  if (!chart) {
    return {
      lod: { queueDepth: 0, totalMs: 0, completed: 0 },
      chunkLod: { queueDepth: 0, totalMs: 0, completed: 0 },
    };
  }
  const debug = chart as Chart & {
    __chartsPlusDebug?: {
      readWorkerStats?: (reset?: boolean) => WorkerStats;
    };
  };
  if (debug.__chartsPlusDebug?.readWorkerStats) {
    return debug.__chartsPlusDebug.readWorkerStats(reset);
  }
  return {
    lod: { queueDepth: 0, totalMs: 0, completed: 0 },
    chunkLod: { queueDepth: 0, totalMs: 0, completed: 0 },
  };
};

const emptyAllocationStats = (): AllocationStats => ({ frame: 0, total: 0, pooled: 0 });
const normalizeAllocationStats = (stats: any): DecimatorAllocationStats => {
  if (stats && typeof stats === 'object' && 'line' in stats) {
    const line = stats.line ?? emptyAllocationStats();
    const chunked = stats.chunked ?? emptyAllocationStats();
    return { line, chunked };
  }
  const line = stats ?? emptyAllocationStats();
  return { line, chunked: emptyAllocationStats() };
};

const readAllocationStats = (chart: Chart | null): DecimatorAllocationStats => {
  if (!chart) {
    return { line: emptyAllocationStats(), chunked: emptyAllocationStats() };
  }
  const debug = chart as Chart & {
    __chartsPlusDebug?: {
      getAllocationStats?: () => AllocationStats | DecimatorAllocationStats;
    };
  };
  return normalizeAllocationStats(debug.__chartsPlusDebug?.getAllocationStats?.());
};

const readLayout = (chart: Chart | null): LayoutResult | null => {
  if (!chart) return null;
  const debug = chart as Chart & {
    __chartsPlusDebug?: {
      getLayout?: () => LayoutResult | null;
    };
  };
  return debug.__chartsPlusDebug?.getLayout ? debug.__chartsPlusDebug.getLayout() : null;
};

const readSeriesRendererInfo = (chart: Chart | null): SeriesRendererInfo | null => {
  if (!chart) return null;
  const debug = chart as Chart & {
    __chartsPlusDebug?: {
      getSeriesRendererInfo?: () => SeriesRendererInfo;
    };
  };
  return debug.__chartsPlusDebug?.getSeriesRendererInfo
    ? debug.__chartsPlusDebug.getSeriesRendererInfo()
    : null;
};

const createPerfSampler = (chartRef: { current: Chart | null }) => {
  let running = false;
  let rafId = 0;
  let lastTime = 0;
  const frameTimes: number[] = [];
  const longTasks: number[] = [];
  const inputLatency: InputLatencySamples = {
    pointerMove: [],
    drag: [],
    wheel: [],
  };
  const eventTiming: InputLatencySamples = {
    pointerMove: [],
    drag: [],
    wheel: [],
  };
  const heapSamples: HeapSample[] = [];
  const workingSetSamples: WorkingSetSample[] = [];
  const heapIntervalMs = 250;
  const workingSetIntervalMs = 2000;
  let heapTimer: number | null = null;
  let workingSetTimer: number | null = null;
  let workingSetPending = false;
  let sampleWindowStart = 0;
  let sampleWindowEnd = 0;
  let inputListenersAttached = false;
  let dragActive = false;
  const pendingLatency: Partial<Record<keyof InputLatencySamples, number>> = {};
  const pendingRaf: Partial<Record<keyof InputLatencySamples, boolean>> = {};
  let observer: PerformanceObserver | null = null;
  let eventObserver: PerformanceObserver | null = null;

  const readRenderStatsSnapshot = (reset: boolean): RenderStats => {
    if (dashboardCharts.length === 0) {
      return readRenderStats(chartRef.current, reset);
    }
    return dashboardCharts.reduce<RenderStats>(
      (acc, chart) => {
        const stats = readRenderStats(chart, reset);
        acc.frames += stats.frames;
        acc.layout += stats.layout;
        acc.series += stats.series;
        acc.overlay += stats.overlay;
        acc.underlay = (acc.underlay ?? 0) + (stats.underlay ?? stats.layout);
        acc.raf = (acc.raf ?? 0) + (stats.raf ?? stats.frames);
        return acc;
      },
      { frames: 0, layout: 0, series: 0, overlay: 0, underlay: 0, raf: 0 },
    );
  };

  const readWorkerStatsSnapshot = (reset: boolean): WorkerStats => {
    if (dashboardCharts.length === 0) {
      return readWorkerStats(chartRef.current, reset);
    }
    return dashboardCharts.reduce<WorkerStats>(
      (acc, chart) => {
        const stats = readWorkerStats(chart, reset);
        acc.lod.queueDepth += stats.lod.queueDepth;
        acc.lod.totalMs += stats.lod.totalMs;
        acc.lod.completed += stats.lod.completed;
        acc.chunkLod.queueDepth += stats.chunkLod.queueDepth;
        acc.chunkLod.totalMs += stats.chunkLod.totalMs;
        acc.chunkLod.completed += stats.chunkLod.completed;
        return acc;
      },
      {
        lod: { queueDepth: 0, totalMs: 0, completed: 0 },
        chunkLod: { queueDepth: 0, totalMs: 0, completed: 0 },
      },
    );
  };

  const readAllocationStatsSnapshot = (): DecimatorAllocationStats => {
    if (dashboardCharts.length === 0) {
      return readAllocationStats(chartRef.current);
    }
    return dashboardCharts.reduce<DecimatorAllocationStats>(
      (acc, chart) => {
        const stats = readAllocationStats(chart);
        acc.line.frame += stats.line.frame;
        acc.line.total += stats.line.total;
        acc.line.pooled += stats.line.pooled;
        acc.chunked.frame += stats.chunked.frame;
        acc.chunked.total += stats.chunked.total;
        acc.chunked.pooled += stats.chunked.pooled;
        return acc;
      },
      { line: emptyAllocationStats(), chunked: emptyAllocationStats() },
    );
  };

  const onFrame = (time: number) => {
    if (!running) return;
    if (lastTime > 0) {
      frameTimes.push(time - lastTime);
    }
    lastTime = time;
    rafId = requestAnimationFrame(onFrame);
  };

  const sampleHeap = () => {
    if (!running) return;
    const memory = (performance as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    heapSamples.push({
      t: performance.now(),
      used: memory?.usedJSHeapSize ?? null,
      total: memory?.totalJSHeapSize ?? null,
      limit: memory?.jsHeapSizeLimit ?? null,
    });
  };

  const sampleWorkingSet = async () => {
    if (!running) return;
    if (workingSetPending) return;
    const measure = (performance as { measureUserAgentSpecificMemory?: () => Promise<{ bytes?: number }> })
      .measureUserAgentSpecificMemory;
    if (typeof measure !== 'function') return;
    workingSetPending = true;
    const t = performance.now();
    try {
      const result = await measure();
      if (running) {
        workingSetSamples.push({
          t,
          bytes: typeof result?.bytes === 'number' ? result.bytes : null,
        });
      }
    } catch {
      if (running) {
        workingSetSamples.push({ t, bytes: null });
      }
    } finally {
      workingSetPending = false;
    }
  };

  const scheduleLatencySample = (kind: keyof InputLatencySamples, eventTime: number) => {
    if (!running) return;
    pendingLatency[kind] = eventTime;
    if (pendingRaf[kind]) return;
    pendingRaf[kind] = true;
    requestAnimationFrame((time) => {
      pendingRaf[kind] = false;
      const startTime = pendingLatency[kind];
      if (startTime === undefined) return;
      pendingLatency[kind] = undefined;
      const now =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : time;
      inputLatency[kind].push(Math.max(0, now - startTime));
    });
  };

  const recordEventTiming = (entry: PerformanceEntry) => {
    if (!running) return;
    const event = entry as PerformanceEntry & { processingStart?: number };
    const name = event.name;
    let kind: keyof InputLatencySamples | null = null;
    if (name === 'pointermove' || name === 'mousemove') {
      kind = dragActive ? 'drag' : 'pointerMove';
    } else if (name === 'wheel') {
      kind = 'wheel';
    }
    if (!kind) return;
    const processingStart = event.processingStart;
    const latency =
      typeof processingStart === 'number' && Number.isFinite(processingStart)
        ? processingStart - event.startTime
        : event.duration;
    if (!Number.isFinite(latency)) return;
    eventTiming[kind].push(Math.max(0, latency));
  };

  const attachInputListeners = () => {
    if (!root || inputListenersAttached) return;
    inputListenersAttached = true;

    root.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button === 0) dragActive = true;
      },
      { passive: true },
    );
    root.addEventListener(
      'pointerup',
      (event) => {
        if (event.button === 0) dragActive = false;
      },
      { passive: true },
    );
    root.addEventListener(
      'pointercancel',
      () => {
        dragActive = false;
      },
      { passive: true },
    );
    root.addEventListener(
      'pointerleave',
      () => {
        dragActive = false;
      },
      { passive: true },
    );
    root.addEventListener(
      'pointermove',
      (event) => {
        if (!running) return;
        const kind = dragActive || event.buttons > 0 ? 'drag' : 'pointerMove';
        scheduleLatencySample(kind, performance.now());
      },
      { passive: true },
    );
    root.addEventListener(
      'wheel',
      () => {
        scheduleLatencySample('wheel', performance.now());
      },
      { passive: true },
    );
  };

  const start = () => {
    if (running) return;
    running = true;
    frameTimes.length = 0;
    longTasks.length = 0;
    inputLatency.pointerMove.length = 0;
    inputLatency.drag.length = 0;
    inputLatency.wheel.length = 0;
    eventTiming.pointerMove.length = 0;
    eventTiming.drag.length = 0;
    eventTiming.wheel.length = 0;
    heapSamples.length = 0;
    workingSetSamples.length = 0;
    lastTime = 0;
    readRenderStatsSnapshot(true);
    readWorkerStatsSnapshot(true);
    attachInputListeners();
    sampleWindowStart = performance.now();
    sampleWindowEnd = sampleWindowStart;

    if (typeof PerformanceObserver !== 'undefined') {
      observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          longTasks.push(entry.duration);
        });
      });
      try {
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        observer.disconnect();
        observer = null;
      }
    }

    if (typeof PerformanceObserver !== 'undefined') {
      const supported = PerformanceObserver.supportedEntryTypes?.includes('event');
      if (supported) {
        eventObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => recordEventTiming(entry));
        });
        try {
          eventObserver.observe({
            type: 'event',
            buffered: true,
            durationThreshold: 0,
          } as PerformanceObserverInit);
        } catch {
          eventObserver.disconnect();
          eventObserver = null;
        }
      }
    }

    sampleHeap();
    sampleWorkingSet();

    heapTimer = window.setInterval(sampleHeap, heapIntervalMs);
    workingSetTimer = window.setInterval(sampleWorkingSet, workingSetIntervalMs);
    rafId = requestAnimationFrame(onFrame);
  };

  const stop = (): PerfSample => {
    if (!running) {
      return {
        frameTimes: [...frameTimes],
        longTasks: [...longTasks],
        inputLatency: {
          pointerMove: [...inputLatency.pointerMove],
          drag: [...inputLatency.drag],
          wheel: [...inputLatency.wheel],
        },
        eventTiming: {
          pointerMove: [...eventTiming.pointerMove],
          drag: [...eventTiming.drag],
          wheel: [...eventTiming.wheel],
        },
        memory: {
          heap: { intervalMs: heapIntervalMs, samples: [...heapSamples] },
          workingSet: { intervalMs: workingSetIntervalMs, samples: [...workingSetSamples] },
        },
        renderStats: readRenderStatsSnapshot(false),
        workerStats: readWorkerStatsSnapshot(false),
        allocationStats: readAllocationStatsSnapshot(),
        sampleWindow: {
          start: sampleWindowStart,
          end: sampleWindowEnd,
          durationMs: Math.max(0, sampleWindowEnd - sampleWindowStart),
        },
      };
    }
    running = false;
    cancelAnimationFrame(rafId);
    observer?.disconnect();
    observer = null;
    eventObserver?.disconnect();
    eventObserver = null;
    if (heapTimer !== null) {
      window.clearInterval(heapTimer);
      heapTimer = null;
    }
    if (workingSetTimer !== null) {
      window.clearInterval(workingSetTimer);
      workingSetTimer = null;
    }
    sampleWindowEnd = performance.now();
    return {
      frameTimes: [...frameTimes],
      longTasks: [...longTasks],
      inputLatency: {
        pointerMove: [...inputLatency.pointerMove],
        drag: [...inputLatency.drag],
        wheel: [...inputLatency.wheel],
      },
      eventTiming: {
        pointerMove: [...eventTiming.pointerMove],
        drag: [...eventTiming.drag],
        wheel: [...eventTiming.wheel],
      },
      memory: {
        heap: { intervalMs: heapIntervalMs, samples: [...heapSamples] },
        workingSet: { intervalMs: workingSetIntervalMs, samples: [...workingSetSamples] },
      },
      renderStats: readRenderStatsSnapshot(true),
      workerStats: readWorkerStatsSnapshot(true),
      allocationStats: readAllocationStatsSnapshot(),
      sampleWindow: {
        start: sampleWindowStart,
        end: sampleWindowEnd,
        durationMs: Math.max(0, sampleWindowEnd - sampleWindowStart),
      },
    };
  };

  const getSampleCounts = () => ({
    inputLatency: {
      pointerMove: inputLatency.pointerMove.length,
      drag: inputLatency.drag.length,
      wheel: inputLatency.wheel.length,
    },
    eventTiming: {
      pointerMove: eventTiming.pointerMove.length,
      drag: eventTiming.drag.length,
      wheel: eventTiming.wheel.length,
    },
  });

  return { start, stop, getSampleCounts };
};

const parseScenario = (value: string | null): ScenarioKey | null => {
  if (!value) return null;
  const upper = value.toUpperCase();
  if (upper === 'A' || upper === 'SCENARIO_A') return 'SCENARIO_A';
  if (upper === 'B' || upper === 'SCENARIO_B') return 'SCENARIO_B';
  if (upper === 'C' || upper === 'SCENARIO_C') return 'SCENARIO_C';
  if (upper === 'D' || upper === 'SCENARIO_D') return 'SCENARIO_D';
  if (upper === 'E' || upper === 'SCENARIO_E') return 'SCENARIO_E';
  if (upper === 'F' || upper === 'SCENARIO_F') return 'SCENARIO_F';
  return null;
};

const parseLibrary = (value: string | null): ChartLibrary => {
  if (!value) return 'charts-plus';
  const lower = value.toLowerCase();
  if (lower === 'lightweight' || lower === 'lightweight-charts' || lower === 'lw') {
    return 'lightweight';
  }
  return 'charts-plus';
};

const parseSeriesRenderer = (value: string | null): SeriesRendererMode | undefined => {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'worker') return 'worker';
  if (lower === 'auto') return 'auto';
  if (lower === 'main') return 'main';
  return undefined;
};

const parseCrosshairMode = (value: string | null): CrosshairMode | undefined => {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'nearest') return 'nearest';
  if (lower === 'interpolate') return 'interpolate';
  if (lower === 'magnet') return 'magnet';
  if (lower === 'ohlc') return 'ohlc';
  return undefined;
};

const parseOptionalNumber = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const resolveCpuClass = (cores: number | null): EnvironmentMeta['cpuClass'] => {
  if (!cores || !Number.isFinite(cores)) return 'unknown';
  if (cores >= 12) return 'high';
  if (cores >= 8) return 'medium';
  return 'low';
};

const getEnvironmentMeta = (): EnvironmentMeta => {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: {
      brands?: Array<{ brand: string; version: string }>;
      platform?: string;
      mobile?: boolean;
    };
  };
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null;
  const deviceMemoryGb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const uaData = nav.userAgentData;
  const brands = uaData?.brands?.map((entry) => `${entry.brand} ${entry.version}`);
  const locale = nav.language ?? 'en-US';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  return {
    userAgent: nav.userAgent,
    platform: uaData?.platform ?? nav.platform ?? 'unknown',
    hardwareConcurrency: cores,
    deviceMemoryGb,
    dpr: typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1,
    locale,
    timeZone,
    cpuClass: resolveCpuClass(cores),
    uaBrands: brands,
    mobile: uaData?.mobile,
  };
};

const params = new URLSearchParams(window.location.search);
const scene = params.get('scene') ?? 'theme-dark';
const scenarioKey = parseScenario(params.get('scenario'));
const library = scenarioKey ? parseLibrary(params.get('lib')) : 'charts-plus';
const seriesRenderer = parseSeriesRenderer(params.get('seriesRenderer'));
const crosshairMode =
  parseCrosshairMode(params.get('crosshair')) ??
  parseCrosshairMode(params.get('crosshairMode'));
const inertiaFriction = parseOptionalNumber(params.get('inertiaFriction'));

let chart: Chart | null = null;
let tvChart: TvChart | null = null;
let tvResizeObserver: ResizeObserver | null = null;
const chartRef = { current: chart };
let dashboardCharts: Chart[] = [];
let dashboardRoot: HTMLElement | null = null;
let scenarioCleanup: (() => void) | null = null;
let sceneTooltipCleanup: (() => void) | null = null;
let scenarioMeta: ScenarioMeta | null = null;
let scenarioData: ScenarioData | null = null;
let crosshairSnapshot: CrosshairSnapshot | null = null;
let crosshairUnsub: (() => void) | null = null;

const applyScene = (target: Chart, sceneName: string) => {
  const start = Date.UTC(2024, 0, 1, 9, 0, 0);
  const step = 60_000;
  const count = 240;
  const end = start + step * (count - 1);

  if (sceneName === 'theme-light') {
    target.setTheme(lightTheme);
    applyPageTheme(lightTheme);
    const series = target.addLineSeries({ id: 'Baseline', colorKey: 'seriesPrimary', width: 2 });
    series.setData(buildWaveSeries(start, count, step, 114, 6, 0, 0.4));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'theme-dark') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const series = target.addLineSeries({
      id: 'Baseline',
      colorKey: 'seriesPrimary',
      width: 2,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    series.setData(buildWaveSeries(start, count, step, 112, 6, 0, 0.2));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'theme-neutral') {
    target.setTheme(neutralTheme);
    applyPageTheme(neutralTheme);
    const series = target.addLineSeries({
      id: 'Neutral',
      colorKey: 'seriesPrimary',
      width: 2,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    series.setData(buildWaveSeries(start, count, step, 114, 6, 0, 0.4));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'gaps') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const series = target.addLineSeries({ id: 'Interrupted', colorKey: 'seriesSecondary', width: 2 });
    series.setData(buildWaveSeries(start, count, step, 118, 7, 18, 0.2));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'multi-series') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const a = target.addLineSeries({ id: 'Alpha', colorKey: 'seriesPrimary', width: 2 });
    const b = target.addLineSeries({
      id: 'Beta',
      colorKey: 'seriesSecondary',
      width: 2,
      dash: [6, 4],
      opacity: 0.9,
    });
    const c = target.addLineSeries({ id: 'Gamma', colorKey: 'seriesTertiary', width: 2 });
    const d = target.addLineSeries({
      id: 'Delta',
      colorKey: 'seriesQuaternary',
      width: 2,
      opacity: 0.8,
    });
    a.setData(buildWaveSeries(start, count, step, 104, 6, 0, 0.1));
    b.setData(buildWaveSeries(start, count, step, 112, 5, 0, 1.3));
    c.setData(buildWaveSeries(start, count, step, 96, 7, 0, 2.1));
    d.setData(buildWaveSeries(start, count, step, 120, 4, 0, 0.7));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'dense-tooltip') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const seriesList: Array<{
      id: string;
      colorKey?: SeriesColorToken;
      color?: string;
      dash?: number[];
      opacity?: number;
      base: number;
      amp: number;
      phase: number;
    }> = [
      { id: 'Growth', colorKey: 'seriesPrimary', base: 112, amp: 6, phase: 0.2 },
      { id: 'Inflation', colorKey: 'seriesSecondary', dash: [6, 4], base: 118, amp: 5, phase: 0.9 },
      { id: 'Rates', colorKey: 'seriesTertiary', base: 104, amp: 7, phase: 1.4 },
      { id: 'FX', colorKey: 'seriesQuaternary', dash: [4, 3], base: 120, amp: 4, phase: 0.4 },
      { id: 'Commodities', colorKey: 'seriesQuinary', base: 96, amp: 8, phase: 2.1 },
      { id: 'Credit', color: '#8fb0ff', opacity: 0.8, base: 110, amp: 6, phase: 1.8 },
      { id: 'Liquidity', color: '#f6a6ff', dash: [3, 4], opacity: 0.8, base: 102, amp: 5, phase: 2.6 },
      { id: 'Risk', color: '#6ee7b7', opacity: 0.85, base: 108, amp: 6, phase: 3.2 },
    ];
    seriesList.forEach((seriesConfig) => {
      const series = target.addLineSeries({
        id: seriesConfig.id,
        colorKey: seriesConfig.colorKey,
        color: seriesConfig.color,
        width: 2,
        dash: seriesConfig.dash,
        opacity: seriesConfig.opacity ?? 0.95,
      });
      series.setData(buildWaveSeries(start, count, step, seriesConfig.base, seriesConfig.amp, 0, seriesConfig.phase));
    });
    target.setVisibleTimeRange({ from: start, to: end });
    sceneTooltipCleanup = attachSceneTooltip(target, darkTheme);
    return;
  }

  if (sceneName === 'area-series') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const area = target.addAreaSeries({
      id: 'Area',
      color: darkTheme.seriesPrimary,
      topColor: 'rgba(92, 200, 255, 0.35)',
      bottomColor: 'rgba(92, 200, 255, 0.06)',
      width: 2,
    });
    area.setData(buildWaveSeries(start, count, step, 112, 6, 0, 0.25));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'baseline-series') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const baseline = target.addBaselineSeries({
      id: 'Baseline',
      color: darkTheme.seriesSecondary,
      topColor: 'rgba(243, 183, 102, 0.35)',
      bottomColor: 'rgba(243, 183, 102, 0.12)',
      baseValue: 112,
      width: 2,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    baseline.setData(buildWaveSeries(start, count, step, 112, 7, 0, 0.5));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'histogram-series') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const baseValue = 112;
    const hist = target.addHistogramSeries({
      id: 'Histogram',
      color: darkTheme.seriesSecondary,
      baseValue,
    });
    const points = buildWaveSeries(start, count, step, 112, 9, 0, 0.35).map((point) => {
      const v = point.v ?? baseValue;
      const color = v >= baseValue ? darkTheme.seriesPrimary : darkTheme.seriesTertiary;
      return { t: point.t, v, color };
    });
    hist.setData(points);
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'candlestick-series') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const candles = target.addCandlestickSeries({
      id: 'Candles',
      upColor: darkTheme.seriesPrimary,
      downColor: darkTheme.seriesSecondary,
      wickColor: 'rgba(230, 236, 245, 0.75)',
      width: 1,
    });
    candles.setData(buildOhlcSeries(start, count, step, 112, 6, 0x9c2f3a4b));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'bar-series') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const bars = target.addBarSeries({
      id: 'Bars',
      upColor: darkTheme.seriesTertiary,
      downColor: darkTheme.seriesQuaternary,
      width: 1,
    });
    bars.setData(buildOhlcSeries(start, count, step, 118, 5, 0x2f7c1234));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'axis-dense') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    target.setAxisOptions('left', { tickCount: 10 });
    target.setAxisOptions('right', { tickCount: 10 });
    const topPane = target.addPane();
    const midPane = target.addPane();
    const bottomPane = target.addPane();
    target.getPane(topPane)?.setHeight(140);
    target.getPane(midPane)?.setHeight(140);
    target.getPane(bottomPane)?.setHeight(140);
    const top = target.addLineSeries({
      id: 'Dense A',
      colorKey: 'seriesPrimary',
      width: 1.8,
      paneId: topPane,
    });
    const mid = target.addLineSeries({
      id: 'Dense B',
      colorKey: 'seriesSecondary',
      width: 1.8,
      paneId: midPane,
      axis: 'right',
    });
    const bottom = target.addLineSeries({
      id: 'Dense C',
      colorKey: 'seriesTertiary',
      width: 1.8,
      paneId: bottomPane,
    });
    top.setData(buildWaveSeries(start, count, step, 110, 8, 0, 0.1));
    mid.setData(buildWaveSeries(start, count, step, 220, 16, 0, 0.6));
    bottom.setData(buildWaveSeries(start, count, step, 92, 7, 0, 1.2));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'axis-sparse') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    target.setAxisOptions('left', { tickCount: 3 });
    const series = target.addLineSeries({
      id: 'Sparse',
      colorKey: 'seriesPrimary',
      width: 2,
    });
    series.setData(buildWaveSeries(start, count, step, 1600, 520, 0, 0.35));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'custom-series') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const base = target.addLineSeries({
      id: 'Baseline',
      colorKey: 'seriesPrimary',
      width: 1.6,
      opacity: 0.35,
    });
    const custom = target.addCustomSeries({
      id: 'Pulse',
      color: darkTheme.seriesSecondary,
      width: 2,
      dash: [4, 4],
      opacity: 0.9,
      renderer: createCustomSeriesRenderer(),
    });
    const points = buildWaveSeries(start, count, step, 112, 6, 0, 0.45);
    base.setData(points);
    custom.setData(points);
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'yield-curve') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const tenors = [1, 2, 3, 6, 12, 24, 36, 60, 120, 240, 360];
    const front = target.addLineSeries({ id: 'Front', colorKey: 'seriesPrimary', width: 2 });
    const mid = target.addLineSeries({
      id: 'Mid',
      colorKey: 'seriesSecondary',
      width: 2,
      dash: [6, 4],
    });
    const long = target.addLineSeries({ id: 'Long', colorKey: 'seriesTertiary', width: 2 });
    front.setData(buildYieldCurveSeries(tenors, 2.1, 0.85, 0.08, 0.2));
    mid.setData(buildYieldCurveSeries(tenors, 2.6, 0.75, 0.12, 0.6));
    long.setData(buildYieldCurveSeries(tenors, 3.1, 0.65, 0.15, 0.9));
    target.setVisibleTimeRange({ from: tenors[0]!, to: tenors[tenors.length - 1]! });
    return;
  }

  if (sceneName === 'options-chain') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const strikes = Array.from({ length: 13 }, (_, i) => 80 + i * 5);
    const calls = target.addLineSeries({ id: 'Calls', colorKey: 'seriesPrimary', width: 2 });
    const puts = target.addLineSeries({
      id: 'Puts',
      colorKey: 'seriesSecondary',
      width: 2,
      dash: [5, 4],
    });
    calls.setData(buildOptionsSmileSeries(strikes, 110, 0.28, -0.08, 0.6));
    puts.setData(buildOptionsSmileSeries(strikes, 90, 0.3, 0.06, 0.55));
    target.setVisibleTimeRange({ from: strikes[0]!, to: strikes[strikes.length - 1]! });
    return;
  }

  if (sceneName === 'price-line') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const primary = target.addLineSeries({
      id: 'Price',
      colorKey: 'seriesPrimary',
      width: 2,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineStyle: 'solid',
      lastValueAnimation: true,
    });
    const secondary = target.addLineSeries({
      id: 'Signal',
      colorKey: 'seriesSecondary',
      width: 2,
      dash: [5, 4],
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineStyle: 'dashed',
      priceLineColor: '#f5a54c',
    });
    primary.setData(buildWaveSeries(start, count, step, 112, 6, 0, 0.35));
    secondary.setData(buildWaveSeries(start, count, step, 120, 5, 0, 1.2));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'multi-axis') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const leftSeries = target.addLineSeries({
      id: 'Growth',
      colorKey: 'seriesPrimary',
      width: 2,
    });
    const rightSeries = target.addLineSeries({
      id: 'Rates',
      colorKey: 'seriesSecondary',
      width: 2,
      axis: 'right',
      dash: [6, 4],
    });
    leftSeries.setData(buildWaveSeries(start, count, step, 112, 6, 0, 0.35));
    const rightValues = buildWaveSeries(start, count, step, 2600, 120, 0, 1.1);
    rightSeries.setData(rightValues);
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'overlays') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const series = target.addLineSeries({ id: 'Signal', colorKey: 'seriesPrimary', width: 2 });
    series.setData(buildWaveSeries(start, count, step, 110, 7, 0, 0.6));
    target.addPlugin(
      createRangeBandPlugin({
        min: 106,
        max: 116,
        opacity: 0.14,
        label: 'Target band',
      }),
    );
    target.addPlugin(
      createAnnotationPlugin([
        { time: start + step * 24, label: 'Open' },
        { time: start + step * 120, label: 'Mid' },
        { time: start + step * 200, label: 'Close' },
      ]),
    );
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'annotations') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const series = target.addLineSeries({ id: 'Signal', colorKey: 'seriesPrimary', width: 2 });
    series.setData(buildWaveSeries(start, count, step, 110, 7, 0, 0.6));
    target.addPlugin(
      createAnnotationPlugin([
        { time: start + step * 32, label: 'Open' },
        { time: start + step * 96, label: 'Briefing' },
        { time: start + step * 156, label: 'Policy' },
        { time: start + step * 210, label: 'Close' },
      ]),
    );
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'pan-cache') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const primary = target.addLineSeries({ id: 'Pan', colorKey: 'seriesPrimary', width: 2 });
    const secondary = target.addLineSeries({
      id: 'Trace',
      colorKey: 'seriesSecondary',
      width: 2,
      dash: [5, 4],
      opacity: 0.85,
    });
    primary.setData(buildWaveSeries(start, count, step, 112, 7, 0, 0.2));
    secondary.setData(buildWaveSeries(start, count, step, 118, 5, 0, 1.1));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'live-mode') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const series = target.addLineSeries({ id: 'Live', colorKey: 'seriesPrimary', width: 2 });
    series.setData(buildWaveSeries(start, count, step, 114, 6, 0, 0.3));
    const windowSpan = step * 80;
    target.setVisibleTimeRange({ from: end - windowSpan, to: end });
    target.setAutoScroll(true);
    return;
  }

  if (sceneName === 'streaming') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const series = target.addLineSeries({ id: 'Stream', colorKey: 'seriesPrimary', width: 2 });
    series.setData(buildWaveSeries(start, count, step, 114, 6, 0, 0.3));
    const windowSpan = step * 80;
    target.setVisibleTimeRange({ from: end - windowSpan, to: end });
    target.setAutoScroll(true);
    const extraCount = 12;
    const extraStart = end + step;
    series.appendBatch(buildWaveSeries(extraStart, extraCount, step, 114, 6, 0, 0.55));
    return;
  }

  if (sceneName === 'multi-pane') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const macroPane = target.addPane();
    const ratesPane = target.addPane();
    const core = target.addLineSeries({ id: 'Core', colorKey: 'seriesPrimary', width: 2 });
    const macro = target.addLineSeries({
      id: 'Macro',
      colorKey: 'seriesSecondary',
      width: 2,
      dash: [6, 4],
      paneId: macroPane,
    });
    const rates = target.addLineSeries({
      id: 'Rates',
      colorKey: 'seriesTertiary',
      width: 2,
      paneId: ratesPane,
      axis: 'right',
    });
    core.setData(buildWaveSeries(start, count, step, 112, 6, 0, 0.1));
    macro.setData(buildWaveSeries(start, count, step, 126, 4, 0, 1.4));
    rates.setData(buildWaveSeries(start, count, step, 98, 5, 0, 0.7));
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  if (sceneName === 'revisions') {
    target.setTheme(darkTheme);
    applyPageTheme(darkTheme);
    const series = target.addLineSeries({ id: 'Revised', colorKey: 'seriesPrimary', width: 2 });
    const points = buildWaveSeries(start, count, step, 112, 6, 0, 0.4);
    series.setData(points);
    const reviseStart = Math.floor(count * 0.45);
    const reviseEnd = Math.min(count, reviseStart + 16);
    const revisions: DataPoint[] = [];
    for (let i = reviseStart; i < reviseEnd; i += 1) {
      const point = points[i];
      if (!point) continue;
      revisions.push({ t: point.t, v: point.v === null ? null : point.v + 7 });
    }
    series.patchExisting(revisions);
    target.setVisibleTimeRange({ from: start, to: end });
    return;
  }

  target.setTheme(darkTheme);
  applyPageTheme(darkTheme);
  const series = target.addLineSeries({ id: 'Baseline', colorKey: 'seriesPrimary', width: 2 });
  series.setData(buildWaveSeries(start, count, step, 112, 6, 0, 0.2));
  target.setVisibleTimeRange({ from: start, to: end });
};

const applyScenarioData = (
  target: Chart,
  data: ScenarioData,
  options: {
    axisResolver?: (index: number, preset: SeriesPreset) => AxisId | undefined;
    idPrefix?: string;
  } = {},
): LineSeries[] => {
  const handles: LineSeries[] = [];
  data.series.forEach(({ preset, points }, index) => {
    const axis = options.axisResolver ? options.axisResolver(index, preset) : undefined;
    const handle = target.addLineSeries({
      id: options.idPrefix ? `${options.idPrefix}-${preset.id}` : preset.id,
      colorKey: preset.colorKey,
      width: 2,
      dash: preset.dash,
      opacity: preset.opacity ?? 0.95,
      axis,
    });
    handle.setData(points);
    handles.push(handle);
  });
  target.setVisibleTimeRange({ from: data.meta.visibleFrom, to: data.meta.visibleTo });
  return handles;
};

const applyScenario = (target: Chart, scenario: ScenarioKey): ScenarioMeta => {
  target.setTheme(darkTheme);
  applyPageTheme(darkTheme);

  const data = buildScenario(scenario);
  scenarioData = data;
  const axisResolver =
    scenario === 'SCENARIO_D' ? (index: number) => (index % 2 === 0 ? 'left' : 'right') : undefined;
  const handles = applyScenarioData(target, data, { axisResolver });

  if (scenario === 'SCENARIO_E') {
    target.setAutoScroll(true);
    const pointsPerSecond = 10_000;
    const durationMs = 60_000;
    const batchIntervalMs = 200;
    const batchSize = Math.round((pointsPerSecond * batchIntervalMs) / 1000);
    let lastTime = data.meta.endTime;
    const rng = mulberry32(data.meta.seed ^ 0x5f356495);
    const cleanupHandles: Array<() => void> = [];
    const timer = window.setInterval(() => {
      const points: DataPoint[] = [];
      for (let i = 0; i < batchSize; i += 1) {
        lastTime += data.meta.baseStepMs;
        const wave =
          Math.sin(lastTime / 120_000) * 2.5 + Math.cos(lastTime / 260_000) * 1.2;
        const noise = (rng() - 0.5) * 0.4;
        points.push({ t: lastTime, v: data.series[0]!.preset.base + wave + noise });
      }
      target.batch(() => {
        handles[0]?.appendBatch(points);
      });
    }, batchIntervalMs);
    cleanupHandles.push(() => window.clearInterval(timer));
    const stopTimer = window.setTimeout(() => {
      cleanupHandles.forEach((fn) => fn());
    }, durationMs);
    cleanupHandles.push(() => window.clearTimeout(stopTimer));
    scenarioCleanup = () => {
      cleanupHandles.forEach((fn) => fn());
    };

    return {
      ...data.meta,
      streaming: {
        pointsPerSecond,
        durationMs,
        batchSize,
        batchIntervalMs,
      },
    };
  }

  return data.meta;
};

const mountDashboardScenario = (): ScenarioMeta => {
  if (!root) {
    throw new Error('Perf harness chart not found.');
  }

  const chartCount = 12;
  const visibleCharts = 4;
  const chartHeight = 120;
  const chartGap = 8;

  root.innerHTML = '';
  root.style.overflow = 'hidden';

  const dashboard = document.createElement('div');
  dashboard.style.display = 'grid';
  dashboard.style.gridTemplateColumns = '1fr';
  dashboard.style.rowGap = `${chartGap}px`;
  dashboard.style.padding = `${chartGap}px`;
  root.appendChild(dashboard);
  dashboardRoot = dashboard;

  const data = buildScenario('SCENARIO_F');
  scenarioData = data;
  applyPageTheme(darkTheme);

  dashboardCharts = [];
  for (let i = 0; i < chartCount; i += 1) {
    const container = document.createElement('div');
    container.style.height = `${chartHeight}px`;
    container.style.width = '100%';
    dashboard.appendChild(container);

    const instance = createCanvasChart(container, {
      autoSize: true,
      seriesRenderer,
      crosshairMode,
      interaction: {
        inertia: {
          friction: inertiaFriction,
        },
      },
    });
    instance.setTheme(darkTheme);
    applyScenarioData(instance, data, { idPrefix: `chart-${i + 1}` });
    dashboardCharts.push(instance);
  }

  chart = dashboardCharts[0] ?? null;
  chartRef.current = chart;
  attachCrosshairListener(chart);

  scenarioCleanup = () => {
    dashboardCharts.forEach((instance) => instance.destroy());
    dashboardCharts = [];
    if (dashboardRoot) {
      dashboardRoot.innerHTML = '';
      dashboardRoot = null;
    }
    root.innerHTML = '';
  };

  return {
    ...data.meta,
    chartCount,
    visibleCharts,
  };
};

const mountSyncPaneScene = (): void => {
  if (!root) {
    throw new Error('Perf harness chart not found.');
  }

  const chartCount = 4;
  const columns = 2;
  const chartHeight = 220;
  const chartGap = 12;
  const start = Date.UTC(2024, 0, 1, 9, 0, 0);
  const step = 60_000;
  const count = 240;
  const end = start + step * (count - 1);

  root.innerHTML = '';
  root.style.overflow = 'hidden';

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  grid.style.gap = `${chartGap}px`;
  grid.style.padding = `${chartGap}px`;
  root.appendChild(grid);
  dashboardRoot = grid;

  applyPageTheme(darkTheme);

  const group = createSyncGroup();
  const charts: Chart[] = [];
  dashboardCharts = [];
  for (let i = 0; i < chartCount; i += 1) {
    const container = document.createElement('div');
    container.style.height = `${chartHeight}px`;
    container.style.width = '100%';
    grid.appendChild(container);

    const instance = createCanvasChart(container, {
      autoSize: true,
      seriesRenderer,
      crosshairMode,
      interaction: {
        inertia: {
          friction: inertiaFriction,
        },
      },
    });
    instance.setTheme(darkTheme);
    const macroPane = instance.addPane();
    const ratesPane = instance.addPane();
    const phase = i * 0.35;
    const core = instance.addLineSeries({ id: `Core-${i + 1}`, colorKey: 'seriesPrimary', width: 2 });
    const macro = instance.addLineSeries({
      id: `Macro-${i + 1}`,
      colorKey: 'seriesSecondary',
      width: 2,
      dash: [6, 4],
      paneId: macroPane,
    });
    const rates = instance.addLineSeries({
      id: `Rates-${i + 1}`,
      colorKey: 'seriesTertiary',
      width: 2,
      paneId: ratesPane,
      axis: 'right',
    });
    core.setData(buildWaveSeries(start, count, step, 112 + i * 4, 6, 0, phase));
    macro.setData(buildWaveSeries(start, count, step, 126 + i * 3, 4, 0, phase + 0.6));
    rates.setData(buildWaveSeries(start, count, step, 98 + i * 5, 5, 0, phase + 1.1));
    instance.setVisibleTimeRange({ from: start, to: end });
    group.add(instance);
    charts.push(instance);
    dashboardCharts.push(instance);
  }

  chart = charts[0] ?? null;
  chartRef.current = chart;
  attachCrosshairListener(chart);

  scenarioCleanup = () => {
    group.destroy();
    charts.forEach((instance) => instance.destroy());
    dashboardCharts = [];
    if (dashboardRoot) {
      dashboardRoot.innerHTML = '';
      dashboardRoot = null;
    }
    root.innerHTML = '';
  };
};

const setSceneReady = (ready: boolean) => {
  (window as typeof window & { __chartsPlusSceneReady?: boolean }).__chartsPlusSceneReady = ready;
};

const setScenarioReady = (ready: boolean) => {
  (window as typeof window & { __chartsPlusScenarioReady?: boolean }).__chartsPlusScenarioReady = ready;
};

const setScenarioError = (message: string | null) => {
  (
    window as typeof window & { __chartsPlusScenarioError?: string | null }
  ).__chartsPlusScenarioError = message;
};

const sampler = createPerfSampler(chartRef);

const attachCrosshairListener = (target: Chart | null) => {
  if (crosshairUnsub) {
    crosshairUnsub();
    crosshairUnsub = null;
  }
  crosshairSnapshot = null;
  if (!target) return;
  crosshairUnsub = target.onCrosshairMove((event) => {
    crosshairSnapshot = {
      time: event.time,
      x: event.x,
      y: event.y,
      seriesValues: Array.from(event.seriesValues.entries()).map(([id, value]) => ({
        id,
        value: value.value,
        formatted: value.formatted,
      })),
    };
  });
};

const clearSceneTooltip = () => {
  if (sceneTooltipCleanup) {
    sceneTooltipCleanup();
    sceneTooltipCleanup = null;
  }
};

const attachSceneTooltip = (target: Chart, theme: ThemeTokens) => {
  if (!root) return () => {};
  if (!root.style.position) {
    root.style.position = 'relative';
  }

  const tooltip = document.createElement('div');
  const fontSize = Math.max(10, Math.round(theme.fontSizePx ?? 12));
  tooltip.style.position = 'absolute';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.zIndex = '3';
  tooltip.style.background = theme.tooltipBackground ?? theme.background;
  tooltip.style.color = theme.tooltipText ?? theme.axisText;
  tooltip.style.border = `1px solid ${theme.tooltipBorder ?? 'rgba(255, 255, 255, 0.12)'}`;
  tooltip.style.borderRadius = '8px';
  tooltip.style.padding = '8px 10px';
  tooltip.style.fontFamily = theme.fontFamily ?? 'sans-serif';
  tooltip.style.fontSize = `${fontSize}px`;
  tooltip.style.lineHeight = '1.35';
  tooltip.style.boxShadow = '0 12px 24px rgba(0, 0, 0, 0.35)';
  tooltip.style.opacity = '0';
  tooltip.style.transform = 'translate(-9999px, -9999px)';
  tooltip.style.whiteSpace = 'nowrap';
  root.appendChild(tooltip);

  const hideTooltip = () => {
    tooltip.style.opacity = '0';
    tooltip.style.transform = 'translate(-9999px, -9999px)';
  };

  const positionTooltip = (anchorX: number, anchorY: number) => {
    const rect = root.getBoundingClientRect();
    const padding = 10;
    const gap = 12;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const preferLeft = anchorX > rect.width * 0.6;
    const preferAbove = anchorY > rect.height * 0.55;
    let x = preferLeft ? anchorX - width - gap : anchorX + gap;
    let y = preferAbove ? anchorY - height - gap : anchorY + gap;
    if (y < padding) y = anchorY + gap;
    x = Math.max(padding, Math.min(x, rect.width - width - padding));
    y = Math.max(padding, Math.min(y, rect.height - height - padding));
    tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  const maxRows = 7;
  const unsubscribe = target.onCrosshairMove((event) => {
    if (!Number.isFinite(event.time) || event.seriesValues.size === 0) {
      hideTooltip();
      return;
    }

    const rows: string[] = [];
    let hidden = 0;
    event.seriesValues.forEach((entry, id) => {
      if (entry.value === null || !Number.isFinite(entry.value)) return;
      if (rows.length < maxRows) {
        const formatted = entry.formatted || 'n/a';
        rows.push(
          `<div style="display:flex;justify-content:space-between;gap:12px"><span>${id}</span><span>${formatted}</span></div>`,
        );
      } else {
        hidden += 1;
      }
    });

    if (rows.length === 0) {
      hideTooltip();
      return;
    }

    const more =
      hidden > 0
        ? `<div style="margin-top:4px;opacity:0.7">+${hidden} more</div>`
        : '';
    tooltip.innerHTML = `<div style="font-weight:600;margin-bottom:4px">${event.formattedTime}</div>${rows.join(
      '',
    )}${more}`;
    tooltip.style.opacity = '1';
    positionTooltip(event.x, event.y);
  });

  const onLeave = () => hideTooltip();
  root.addEventListener('pointerleave', onLeave);

  return () => {
    unsubscribe();
    root.removeEventListener('pointerleave', onLeave);
    tooltip.remove();
  };
};

const mount = () => {
  if (!root) return;
  scenarioCleanup?.();
  scenarioCleanup = null;
  clearSceneTooltip();
  dashboardCharts = [];
  dashboardRoot = null;
  setSceneReady(false);
  setScenarioReady(false);
  setScenarioError(null);
  try {
    if (scenarioKey && library === 'lightweight') {
      if (scenarioKey === 'SCENARIO_E' || scenarioKey === 'SCENARIO_F') {
        throw new Error(`Scenario ${scenarioKey} is available for charts-plus only.`);
      }
      const tv = createTradingViewChart();
      tvChart = tv?.chart ?? null;
      tvResizeObserver = tv?.resizeObserver ?? null;
      chart = null;
      chartRef.current = null;
      attachCrosshairListener(null);
      if (tvChart) {
        scenarioMeta = applyScenarioToTradingView(tvChart, scenarioKey);
      }
    } else if (scenarioKey === 'SCENARIO_F') {
      scenarioMeta = mountDashboardScenario();
    } else if (scene === 'sync-multi-pane') {
      mountSyncPaneScene();
    } else {
      const chartOptions = {
        autoSize: true,
        seriesRenderer,
        crosshairMode,
        interaction: {
          inertia: {
            friction: inertiaFriction,
          },
        },
      };
      if (scene === 'yield-curve') {
        chart = createYieldCurveChart(root, chartOptions);
      } else if (scene === 'options-chain') {
        chart = createOptionsChart(root, chartOptions);
      } else {
        chart = createCanvasChart(root, chartOptions);
      }
      chartRef.current = chart;
      attachCrosshairListener(chart);

      if (scenarioKey) {
        scenarioMeta = applyScenario(chart, scenarioKey);
      } else {
        applyScene(chart, scene);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setScenarioError(message);
    // eslint-disable-next-line no-console
    console.error('[perf-harness] mount error', error);
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (scenarioKey) {
        setScenarioReady(true);
      } else {
        setSceneReady(true);
      }
    });
  });
};

const unmount = () => {
  if (!root) return;
  scenarioCleanup?.();
  scenarioCleanup = null;
  if (chart) {
    chart.destroy();
  }
  dashboardCharts = [];
  dashboardRoot = null;
  if (tvChart) {
    tvResizeObserver?.disconnect();
    tvResizeObserver = null;
    tvChart.remove();
  }
  chart = null;
  tvChart = null;
  chartRef.current = null;
  scenarioMeta = null;
  scenarioData = null;
  attachCrosshairListener(null);
  setSceneReady(false);
  setScenarioReady(false);
  setScenarioError(null);
};

const readDashboardRenderStats = (reset = false): RenderStats => {
  if (dashboardCharts.length === 0) {
    return readRenderStats(chart, reset);
  }
  return dashboardCharts.reduce<RenderStats>(
    (acc, instance) => {
      const stats = readRenderStats(instance, reset);
      acc.frames += stats.frames;
      acc.layout += stats.layout;
      acc.series += stats.series;
      acc.overlay += stats.overlay;
      acc.underlay = (acc.underlay ?? 0) + (stats.underlay ?? stats.layout);
      acc.raf = (acc.raf ?? 0) + (stats.raf ?? stats.frames);
      return acc;
    },
    { frames: 0, layout: 0, series: 0, overlay: 0, underlay: 0, raf: 0 },
  );
};

const readDashboardWorkerStats = (reset = false): WorkerStats => {
  if (dashboardCharts.length === 0) {
    return readWorkerStats(chart, reset);
  }
  return dashboardCharts.reduce<WorkerStats>(
    (acc, instance) => {
      const stats = readWorkerStats(instance, reset);
      acc.lod.queueDepth += stats.lod.queueDepth;
      acc.lod.totalMs += stats.lod.totalMs;
      acc.lod.completed += stats.lod.completed;
      acc.chunkLod.queueDepth += stats.chunkLod.queueDepth;
      acc.chunkLod.totalMs += stats.chunkLod.totalMs;
      acc.chunkLod.completed += stats.chunkLod.completed;
      return acc;
    },
    {
      lod: { queueDepth: 0, totalMs: 0, completed: 0 },
      chunkLod: { queueDepth: 0, totalMs: 0, completed: 0 },
    },
  );
};

const readDashboardAllocationStats = (): DecimatorAllocationStats => {
  if (dashboardCharts.length === 0) {
    return readAllocationStats(chart);
  }
  return dashboardCharts.reduce<DecimatorAllocationStats>(
    (acc, instance) => {
      const stats = readAllocationStats(instance);
      acc.line.frame += stats.line.frame;
      acc.line.total += stats.line.total;
      acc.line.pooled += stats.line.pooled;
      acc.chunked.frame += stats.chunked.frame;
      acc.chunked.total += stats.chunked.total;
      acc.chunked.pooled += stats.chunked.pooled;
      return acc;
    },
    { line: emptyAllocationStats(), chunked: emptyAllocationStats() },
  );
};

const readDashboardRenderStatsList = (reset = false): RenderStats[] => {
  if (dashboardCharts.length === 0) return [];
  return dashboardCharts.map((instance) => readRenderStats(instance, reset));
};

const readDashboardVisibleRanges = (): Array<VisibleTimeRange | null> => {
  if (dashboardCharts.length === 0) {
    return chart ? [chart.getVisibleTimeRange()] : [];
  }
  return dashboardCharts.map((instance) => instance.getVisibleTimeRange());
};

const readSeriesLodInfo = () => {
  const charts = dashboardCharts.length > 0 ? dashboardCharts : chart ? [chart] : [];
  const info: Array<{
    id: string;
    levelCount: number;
    levels: Array<{ bucketSize: number; length: number }>;
    building: boolean;
  }> = [];
  charts.forEach((instance) => {
    const debug = (instance as Chart & { __chartsPlusDebug?: { getSeriesLodInfo?: () => typeof info } })
      .__chartsPlusDebug;
    const seriesInfo = debug?.getSeriesLodInfo?.();
    if (seriesInfo) {
      info.push(...seriesInfo);
    }
  });
  return info;
};

type SeriesLodInfo = ReturnType<typeof readSeriesLodInfo>;

const getCanvasCount = () => (root ? root.querySelectorAll('canvas').length : 0);

if (root) {
  mount();
}

(window as typeof window & {
  __chartsPlusPerf?: {
    startSampling: () => void;
    stopSampling: () => PerfSample;
    getScenarioMeta: () => ScenarioMeta | null;
    getScenarioData: () => ScenarioData | null;
    getEnvironmentMeta: () => EnvironmentMeta;
    getRenderStats: (reset?: boolean) => RenderStats;
    getDashboardRenderStats: (reset?: boolean) => RenderStats[];
    getWorkerStats: (reset?: boolean) => WorkerStats;
    getSeriesRendererInfo: () => SeriesRendererInfo | null;
    getAllocationStats: () => DecimatorAllocationStats;
    exportPng: (options?: ExportPngOptions) => Promise<string | null>;
    getSampleCounts: () => {
      inputLatency: { pointerMove: number; drag: number; wheel: number };
      eventTiming: { pointerMove: number; drag: number; wheel: number };
    };
    getVisibleTimeRange: () => VisibleTimeRange | null;
    getDashboardVisibleRanges: () => Array<VisibleTimeRange | null>;
    getLayout: () => LayoutResult | null;
    getCrosshairState: () => CrosshairSnapshot | null;
    getSeriesLodInfo: () => SeriesLodInfo;
  };
}).__chartsPlusPerf = scenarioKey
  ? {
      startSampling: () => sampler.start(),
      stopSampling: () => sampler.stop(),
      getScenarioMeta: () => scenarioMeta,
      getScenarioData: () => scenarioData,
      getEnvironmentMeta: () => getEnvironmentMeta(),
      getRenderStats: (reset = false) => readDashboardRenderStats(reset),
      getDashboardRenderStats: (reset = false) => readDashboardRenderStatsList(reset),
      getWorkerStats: (reset = false) => readDashboardWorkerStats(reset),
      getSeriesRendererInfo: () => readSeriesRendererInfo(chart),
      getAllocationStats: () => readDashboardAllocationStats(),
      exportPng: async (options?: ExportPngOptions) => {
        if (!chart) return null;
        const result = await chart.exportPng(options);
        if (typeof result === 'string') return result;
        if (typeof FileReader === 'undefined' || !result) return null;
        return await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.readAsDataURL(result);
        });
      },
      getSampleCounts: () => sampler.getSampleCounts(),
      getVisibleTimeRange: () => (chart ? chart.getVisibleTimeRange() : null),
      getDashboardVisibleRanges: () => readDashboardVisibleRanges(),
      getLayout: () => readLayout(chart),
      getCrosshairState: () => crosshairSnapshot,
      getSeriesLodInfo: () => readSeriesLodInfo(),
    }
  : undefined;

(window as typeof window & {
  __chartsPlusScene?: {
    getRenderStats: (reset?: boolean) => RenderStats | null;
    getDashboardRenderStats: (reset?: boolean) => RenderStats[];
    getDashboardVisibleRanges: () => Array<VisibleTimeRange | null>;
    getSeriesLodInfo: () => SeriesLodInfo;
  };
}).__chartsPlusScene = {
  getRenderStats: (reset = false) => readDashboardRenderStats(reset),
  getDashboardRenderStats: (reset = false) => readDashboardRenderStatsList(reset),
  getDashboardVisibleRanges: () => readDashboardVisibleRanges(),
  getSeriesLodInfo: () => readSeriesLodInfo(),
};

(window as typeof window & {
  __chartsPlusTest?: {
    mount: () => void;
    unmount: () => void;
    getCanvasCount: () => number;
  };
}).__chartsPlusTest = {
  mount,
  unmount,
  getCanvasCount,
};
