import type { LineSeriesOptions, PriceScaleMode, Rect, VisibleTimeRange } from '@charts-plus/chart-core';
import { PriceScale, applyPriceScaleMode } from '@charts-plus/chart-core';

const EMPTY_DASH: number[] = [];

export type SnapSurface = {
  snapX: (x: number, strokeWidth?: number) => number;
  snapY: (y: number, strokeWidth?: number) => number;
  alignLineWidth: (width: number) => number;
  isPanActive?: () => boolean;
};

export type LineSeriesRenderInput = {
  ctx: CanvasRenderingContext2D;
  surface: SnapSurface;
  plotRect: Rect;
  clipRect?: Rect;
  xOffset?: number;
  visibleRange: VisibleTimeRange;
  time: Float64Array;
  value: Float64Array;
  priceScale: PriceScale;
  scaleMode?: PriceScaleMode;
  scaleBase?: number | null;
  options: LineSeriesOptions;
  defaultColor: string;
  usePath2D?: boolean;
  gapThresholdMs?: number | null;
  pathCache?: LinePathCache;
  pathCacheKey?: string;
};

const intersectRect = (base: Rect, clip?: Rect): Rect => {
  if (!clip) return base;
  const x1 = Math.max(base.x, clip.x);
  const y1 = Math.max(base.y, clip.y);
  const x2 = Math.min(base.x + base.width, clip.x + clip.width);
  const y2 = Math.min(base.y + base.height, clip.y + clip.height);
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1),
  };
};

export type LinePathCacheEntry = {
  path: Path2D;
  hasStroke: boolean;
};

export type LinePathCache = {
  get: (key: string) => LinePathCacheEntry | undefined;
  set: (key: string, entry: LinePathCacheEntry) => void;
};

export function renderLineSeries(input: LineSeriesRenderInput): void {
  const {
    ctx,
    surface,
    plotRect,
    clipRect,
    xOffset,
    visibleRange,
    time,
    value,
    priceScale,
    scaleMode = 'normal',
    scaleBase = null,
    options,
    defaultColor,
    usePath2D,
    pathCache,
    pathCacheKey,
  } = input;

  const clip = intersectRect(plotRect, clipRect);
  if (clip.width <= 0 || clip.height <= 0) return;
  if (time.length === 0 || value.length === 0) return;

  const span = visibleRange.to - visibleRange.from;
  if (span <= 0) return;

  const lineWidth = Math.max(1, options.width ?? 2);
  const alignedLineWidth = surface.alignLineWidth(lineWidth);
  const stroke = options.color ?? defaultColor;
  const opacity = options.opacity ?? 1;
  if (opacity <= 0) return;
  const renderMode = options.renderMode === 'step' ? 'step' : 'linear';
  const gapThresholdMs =
    typeof input.gapThresholdMs === 'number' && Number.isFinite(input.gapThresholdMs) && input.gapThresholdMs > 0
      ? input.gapThresholdMs
      : null;

  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.width, clip.height);
  ctx.clip();

  ctx.strokeStyle = stroke;
  ctx.lineWidth = alignedLineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = opacity;
  if (options.dash && options.dash.length > 0) {
    ctx.setLineDash(options.dash);
  } else {
    ctx.setLineDash(EMPTY_DASH);
  }

  const scaleX = plotRect.width / span;
  const offsetX = plotRect.x - visibleRange.from * scaleX + (xOffset ?? 0);
  const canUsePath2D = usePath2D && typeof Path2D !== 'undefined';
  let path: Path2D | null = null;
  let hasStroke = false;
  let shouldBuildPath = false;
  if (canUsePath2D && pathCache && pathCacheKey) {
    const cached = pathCache.get(pathCacheKey);
    if (cached) {
      path = cached.path;
      hasStroke = cached.hasStroke;
    }
  }
  if (!path && canUsePath2D) {
    path = new Path2D();
    shouldBuildPath = true;
  }
  let started = false;
  let prevY = 0;
  let prevTime = Number.NaN;

  if (!path) {
    ctx.beginPath();
  }
  if (shouldBuildPath || !path) {
    const count = Math.min(time.length, value.length);
    for (let i = 0; i < count; i += 1) {
      const v = value[i]!;
      if (!Number.isFinite(v)) {
        started = false;
        prevTime = Number.NaN;
        continue;
      }
      const scaled = scaleMode === 'normal' ? v : applyPriceScaleMode(v, scaleMode, scaleBase);
      const yValue = priceScale.valueToY(scaled);
      if (!Number.isFinite(yValue)) {
        started = false;
        prevTime = Number.NaN;
        continue;
      }

      const t = time[i]!;
      if (started && gapThresholdMs !== null && Number.isFinite(prevTime) && t - prevTime > gapThresholdMs) {
        started = false;
      }
      const x = surface.snapX(offsetX + t * scaleX, alignedLineWidth);
      const y = surface.snapY(plotRect.y + yValue, alignedLineWidth);
      if (!started) {
        if (path) {
          path.moveTo(x, y);
        } else {
          ctx.moveTo(x, y);
        }
        started = true;
        hasStroke = true;
        prevY = y;
        prevTime = t;
      } else {
        if (renderMode === 'step') {
          if (path) {
            path.lineTo(x, prevY);
            path.lineTo(x, y);
          } else {
            ctx.lineTo(x, prevY);
            ctx.lineTo(x, y);
          }
        } else if (path) {
          path.lineTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevY = y;
        prevTime = t;
      }
    }
    if (path && pathCache && pathCacheKey) {
      pathCache.set(pathCacheKey, { path, hasStroke });
    }
  }

  if (hasStroke) {
    if (path) {
      ctx.stroke(path);
    } else {
      ctx.stroke();
    }
  }

  ctx.restore();
}
