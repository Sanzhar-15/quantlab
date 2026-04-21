import type { LineSeriesOptions, PriceScaleMode, Rect, VisibleTimeRange } from '@charts-plus/chart-core';
import { PriceScale, applyPriceScaleMode } from '@charts-plus/chart-core';

import type { SnapSurface } from './line-series-renderer';

type FillStyle = string | CanvasGradient | CanvasPattern;

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

const clampY = (plotRect: Rect, y: number): number => {
  const minY = plotRect.y;
  const maxY = plotRect.y + plotRect.height;
  return Math.min(maxY, Math.max(minY, y));
};

export type AreaFillInput = {
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
  lineWidth: number;
  renderMode: 'linear' | 'step';
  fillStyle: FillStyle;
  baselineValue?: number | null;
  baselineY?: number;
  gapThresholdMs?: number | null;
};

const resolveBaselineY = (input: AreaFillInput, alignedLineWidth: number): number => {
  if (Number.isFinite(input.baselineY)) {
    return clampY(input.plotRect, input.surface.snapY(input.baselineY!, alignedLineWidth));
  }
  const base = input.baselineValue;
  const plotRect = input.plotRect;
  if (Number.isFinite(base)) {
    const scaleMode = input.scaleMode ?? 'normal';
    const scaled = scaleMode === 'normal' ? base! : applyPriceScaleMode(base!, scaleMode, input.scaleBase ?? null);
    const yValue = input.priceScale.valueToY(scaled);
    if (Number.isFinite(yValue)) {
      const y = plotRect.y + yValue;
      return clampY(plotRect, input.surface.snapY(y, alignedLineWidth));
    }
  }
  return clampY(plotRect, input.surface.snapY(plotRect.y + plotRect.height, alignedLineWidth));
};

const finishSegment = (
  ctx: CanvasRenderingContext2D,
  baselineY: number,
  lastX: number,
  started: boolean,
): boolean => {
  if (!started) return false;
  ctx.lineTo(lastX, baselineY);
  ctx.closePath();
  ctx.fill();
  return false;
};

export const renderAreaFill = (input: AreaFillInput): void => {
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
    lineWidth,
    renderMode,
    fillStyle,
  } = input;

  const clip = intersectRect(plotRect, clipRect);
  if (clip.width <= 0 || clip.height <= 0) return;
  if (time.length === 0 || value.length === 0) return;

  const span = visibleRange.to - visibleRange.from;
  if (span <= 0) return;

  const alignedLineWidth = surface.alignLineWidth(Math.max(1, lineWidth));
  const baselineY = resolveBaselineY(input, alignedLineWidth);
  const gapThresholdMs =
    typeof input.gapThresholdMs === 'number' && Number.isFinite(input.gapThresholdMs) && input.gapThresholdMs > 0
      ? input.gapThresholdMs
      : null;

  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.width, clip.height);
  ctx.clip();
  ctx.fillStyle = fillStyle;
  ctx.globalAlpha = input.options.opacity ?? 1;

  const scaleX = plotRect.width / span;
  const offsetX = plotRect.x - visibleRange.from * scaleX + (xOffset ?? 0);
  let started = false;
  let prevY = 0;
  let prevTime = Number.NaN;
  let prevX = 0;

  const count = Math.min(time.length, value.length);
  for (let i = 0; i < count; i += 1) {
    const v = value[i]!;
    if (!Number.isFinite(v)) {
      started = finishSegment(ctx, baselineY, prevX, started);
      prevTime = Number.NaN;
      continue;
    }
    const scaled = scaleMode === 'normal' ? v : applyPriceScaleMode(v, scaleMode, scaleBase);
    const yValue = priceScale.valueToY(scaled);
    if (!Number.isFinite(yValue)) {
      started = finishSegment(ctx, baselineY, prevX, started);
      prevTime = Number.NaN;
      continue;
    }

    const t = time[i]!;
    if (started && gapThresholdMs !== null && Number.isFinite(prevTime) && t - prevTime > gapThresholdMs) {
      started = finishSegment(ctx, baselineY, prevX, started);
    }

    const x = surface.snapX(offsetX + t * scaleX, alignedLineWidth);
    const y = surface.snapY(plotRect.y + yValue, alignedLineWidth);

    if (!started) {
      ctx.beginPath();
      ctx.moveTo(x, baselineY);
      ctx.lineTo(x, y);
      started = true;
    } else if (renderMode === 'step') {
      ctx.lineTo(x, prevY);
      ctx.lineTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }

    prevX = x;
    prevY = y;
    prevTime = t;
  }

  finishSegment(ctx, baselineY, prevX, started);
  ctx.restore();
};

export type BaselineFillInput = Omit<AreaFillInput, 'fillStyle' | 'baselineY'> & {
  topFill: FillStyle;
  bottomFill: FillStyle;
  baselineValue: number;
};

export const renderBaselineFill = (input: BaselineFillInput): number | null => {
  const { plotRect } = input;
  const lineWidth = Math.max(1, input.lineWidth);
  const alignedLineWidth = input.surface.alignLineWidth(lineWidth);
  const baselineY = resolveBaselineY(
    {
      ...input,
      fillStyle: input.topFill,
      baselineValue: input.baselineValue,
    },
    alignedLineWidth,
  );

  const clip = intersectRect(plotRect, input.clipRect);
  if (clip.width <= 0 || clip.height <= 0) return null;

  const topHeight = Math.max(0, baselineY - clip.y);
  const bottomHeight = Math.max(0, clip.y + clip.height - baselineY);

  if (topHeight > 0) {
    renderAreaFill({
      ...input,
      fillStyle: input.topFill,
      clipRect: { x: clip.x, y: clip.y, width: clip.width, height: topHeight },
      baselineY,
    });
  }

  if (bottomHeight > 0) {
    renderAreaFill({
      ...input,
      fillStyle: input.bottomFill,
      clipRect: { x: clip.x, y: baselineY, width: clip.width, height: bottomHeight },
      baselineY,
    });
  }

  return baselineY;
};
