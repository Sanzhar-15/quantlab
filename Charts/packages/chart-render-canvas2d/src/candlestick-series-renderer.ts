import type {
  CandlestickSeriesOptions,
  PriceScaleMode,
  Rect,
  VisibleTimeRange,
} from '@charts-plus/chart-core';
import { PriceScale, applyPriceScaleMode } from '@charts-plus/chart-core';

import type { SnapSurface } from './line-series-renderer';

export type CandlestickSeriesRenderInput = {
  ctx: CanvasRenderingContext2D;
  surface: SnapSurface;
  plotRect: Rect;
  clipRect?: Rect;
  xOffset?: number;
  visibleRange: VisibleTimeRange;
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  priceScale: PriceScale;
  scaleMode?: PriceScaleMode;
  scaleBase?: number | null;
  options: CandlestickSeriesOptions;
  defaultColor: string;
  barWidth: number;
  dpr?: number;
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

const alignToDevicePixel = (value: number, dpr: number): number => {
  if (!Number.isFinite(value)) return value;
  const scale = Math.max(1, dpr || 1);
  return Math.round(value * scale) / scale;
};

const resolveBarGeometry = (center: number, width: number, dpr: number): { left: number; width: number } => {
  const safeDpr = Math.max(1, dpr || 1);
  const deviceWidth = Math.max(1, Math.round(width * safeDpr));
  const halfDevice = Math.floor(deviceWidth / 2);
  const centerDevice = Math.round(center * safeDpr);
  const leftDevice = centerDevice - halfDevice;
  return { left: leftDevice / safeDpr, width: deviceWidth / safeDpr };
};

export const renderCandlestickSeries = (input: CandlestickSeriesRenderInput): void => {
  const {
    ctx,
    surface,
    plotRect,
    clipRect,
    xOffset,
    visibleRange,
    time,
    open,
    high,
    low,
    close,
    priceScale,
    options,
    defaultColor,
    barWidth,
  } = input;

  const safeDpr = Math.max(1, input.dpr ?? 1);
  const scaleMode = input.scaleMode ?? 'normal';
  const scaleBase = input.scaleBase ?? null;
  const lineWidth = surface.alignLineWidth(Math.max(1, options.width ?? 1));
  const bodyWidth = Math.max(1 / safeDpr, barWidth);
  const minBodyHeight = 1 / safeDpr;

  // Expand plotRect to account for candlestick width (half bar width on each side)
  // This prevents leftmost/rightmost candles from being clipped by axis margins
  // Add RHS safety margin to prevent overlap with price scale
  const RHS_SAFETY_MARGIN_PX = 2; // Prevent overlap with RHS scale
  const halfBarWidth = bodyWidth * 0.5;
  const scaledMargin = RHS_SAFETY_MARGIN_PX * safeDpr;
  const expandedPlotRect: Rect = {
    x: plotRect.x - halfBarWidth,
    y: plotRect.y,
    width: plotRect.width + halfBarWidth - scaledMargin, // Expand left, constrain right
    height: plotRect.height,
  };

  const clip = intersectRect(expandedPlotRect, clipRect);
  if (clip.width <= 0 || clip.height <= 0) return;
  if (time.length === 0) return;

  const span = visibleRange.to - visibleRange.from;
  if (span <= 0) return;

  const opacity = options.opacity ?? 1;
  if (opacity <= 0) return;

  const upColor = options.upColor ?? options.color ?? defaultColor;
  const downColor = options.downColor ?? options.color ?? defaultColor;
  const wickColor = options.wickColor ?? null;

  // V12 Polish: Auto-disable borders when candles are too small
  // Borders add visual clutter at high density and consume body width
  const borderThreshold = 4; // CSS pixels
  const borderVisible = (options.borderVisible ?? true) && bodyWidth >= borderThreshold;

  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.width, clip.height);
  ctx.clip();
  ctx.globalAlpha = opacity;
  ctx.setLineDash([]);
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';

  // Use original plotRect for coordinate calculations (not expanded)
  // The expansion is only for clipping to allow candles to extend beyond edges
  const scaleX = plotRect.width / span;
  const offsetX = plotRect.x - visibleRange.from * scaleX + (xOffset ?? 0);

  let lastWick = '';
  let lastBody = '';
  const count = Math.min(time.length, open.length, high.length, low.length, close.length);
  for (let i = 0; i < count; i += 1) {
    const o = open[i]!;
    const h = high[i]!;
    const l = low[i]!;
    const c = close[i]!;
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
      continue;
    }

    const scaledOpen = scaleMode === 'normal' ? o : applyPriceScaleMode(o, scaleMode, scaleBase);
    const scaledHigh = scaleMode === 'normal' ? h : applyPriceScaleMode(h, scaleMode, scaleBase);
    const scaledLow = scaleMode === 'normal' ? l : applyPriceScaleMode(l, scaleMode, scaleBase);
    const scaledClose = scaleMode === 'normal' ? c : applyPriceScaleMode(c, scaleMode, scaleBase);
    const yOpen = priceScale.valueToY(scaledOpen);
    const yHigh = priceScale.valueToY(scaledHigh);
    const yLow = priceScale.valueToY(scaledLow);
    const yClose = priceScale.valueToY(scaledClose);
    if (!Number.isFinite(yOpen) || !Number.isFinite(yHigh) || !Number.isFinite(yLow) || !Number.isFinite(yClose)) {
      continue;
    }

    const t = time[i]!;
    const center = offsetX + t * scaleX;
    const x = surface.snapX(center, lineWidth);

    const yHighSnap = surface.snapY(plotRect.y + yHigh, lineWidth);
    const yLowSnap = surface.snapY(plotRect.y + yLow, lineWidth);

    let bodyTop = alignToDevicePixel(plotRect.y + Math.min(yOpen, yClose), safeDpr);
    let bodyBottom = alignToDevicePixel(plotRect.y + Math.max(yOpen, yClose), safeDpr);
    if (bodyBottom - bodyTop < minBodyHeight) {
      const mid = (bodyTop + bodyBottom) * 0.5;
      bodyTop = alignToDevicePixel(mid - minBodyHeight * 0.5, safeDpr);
      bodyBottom = alignToDevicePixel(mid + minBodyHeight * 0.5, safeDpr);
    }

    const body = resolveBarGeometry(center, bodyWidth, safeDpr);
    const isUp = c >= o;
    const bodyColor = isUp ? upColor : downColor;
    const wickStroke = wickColor ?? bodyColor;

    if (wickStroke !== lastWick) {
      ctx.strokeStyle = wickStroke;
      lastWick = wickStroke;
    }
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x, yHighSnap);
    ctx.lineTo(x, yLowSnap);
    ctx.stroke();

    if (bodyColor !== lastBody) {
      ctx.fillStyle = bodyColor;
      lastBody = bodyColor;
    }
    ctx.fillRect(body.left, bodyTop, body.width, bodyBottom - bodyTop);

    if (borderVisible) {
      ctx.strokeStyle = bodyColor;
      ctx.lineWidth = lineWidth;
      const inset = lineWidth * 0.5;
      const strokeLeft = alignToDevicePixel(body.left + inset, safeDpr);
      const strokeTop = alignToDevicePixel(bodyTop + inset, safeDpr);
      const strokeWidth = Math.max(0, body.width - lineWidth);
      const strokeHeight = Math.max(0, bodyBottom - bodyTop - lineWidth);
      if (strokeWidth > 0 && strokeHeight > 0) {
        ctx.strokeRect(strokeLeft, strokeTop, strokeWidth, strokeHeight);
      }
    }
  }

  ctx.restore();
};
