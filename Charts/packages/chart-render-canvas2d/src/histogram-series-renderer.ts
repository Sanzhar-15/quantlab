import type {
  HistogramSeriesOptions,
  PriceScaleMode,
  Rect,
  VisibleTimeRange,
} from '@charts-plus/chart-core';
import { PriceScale, applyPriceScaleMode } from '@charts-plus/chart-core';

import type { SnapSurface } from './line-series-renderer';

export type HistogramColorResolver = (time: number, index: number) => string | null;

export type HistogramSeriesRenderInput = {
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
  options: HistogramSeriesOptions;
  defaultColor: string;
  baseValue: number;
  barWidth: number;
  dpr?: number;
  colorResolver?: HistogramColorResolver;
  isVolume?: boolean;
  maxVolume?: number;
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

const clampY = (plotRect: Rect, y: number): number => {
  const minY = plotRect.y;
  const maxY = plotRect.y + plotRect.height;
  return Math.min(maxY, Math.max(minY, y));
};

const resolveBaselineY = (
  plotRect: Rect,
  priceScale: PriceScale,
  scaleMode: PriceScaleMode,
  scaleBase: number | null,
  baseValue: number,
  dpr: number,
): number => {
  const base = Number.isFinite(baseValue) ? baseValue : 0;
  const scaled = scaleMode === 'normal' ? base : applyPriceScaleMode(base, scaleMode, scaleBase);
  const yValue = priceScale.valueToY(scaled);
  if (!Number.isFinite(yValue)) {
    return clampY(plotRect, alignToDevicePixel(plotRect.y + plotRect.height, dpr));
  }
  const y = plotRect.y + yValue;
  return clampY(plotRect, alignToDevicePixel(y, dpr));
};

export const renderHistogramSeries = (input: HistogramSeriesRenderInput): void => {
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
    options,
    defaultColor,
    baseValue,
    barWidth,
    colorResolver,
    isVolume,
    maxVolume,
  } = input;

  const clip = intersectRect(plotRect, clipRect);
  if (clip.width <= 0 || clip.height <= 0) return;
  if (time.length === 0 || value.length === 0) return;

  const span = visibleRange.to - visibleRange.from;
  if (span <= 0) return;

  const opacity = options.opacity ?? 1;
  if (opacity <= 0) return;

  const safeDpr = Math.max(1, input.dpr ?? 1);
  const rawBarWidth = Number.isFinite(barWidth) && barWidth > 0 ? barWidth : clip.width;

  // V9: Enhance zoomed-out look
  // If bars are very thin (< 3 physical pixels), gradients look muddy/washed out.
  // We switch to solid colors for crispness.
  const barWidthDevice = Math.max(1, Math.round(rawBarWidth * safeDpr));
  const isThinBar = barWidthDevice < 3 * safeDpr; // < 3 logical pixels

  // Force 1px aligned width for very thin bars to avoid sub-pixel blurring
  const barWidthAligned = barWidthDevice / safeDpr;
  const halfDeviceWidth = Math.floor(barWidthDevice / 2);

  const scaleMode = input.scaleMode ?? 'normal';
  const scaleBase = input.scaleBase ?? null;

  // Smart Volume Scaling: bottom 20% of pane
  const volRatio = 0.2;
  const volHeight = plotRect.height * volRatio;
  const volBottom = plotRect.y + plotRect.height;
  const safeMaxVolume = (maxVolume ?? 0) || 1;

  const baselineY = isVolume
    ? volBottom
    : resolveBaselineY(plotRect, priceScale, scaleMode, scaleBase, baseValue, safeDpr);

  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.width, clip.height);
  ctx.clip();
  ctx.globalAlpha = opacity;

  const scaleX = plotRect.width / span;
  const offsetX = plotRect.x - visibleRange.from * scaleX + (xOffset ?? 0);

  // Optimization: Pre-calculate gradients for Up/Down bars if this is a Volume overlay
  let upGradient: CanvasGradient | null = null;
  let downGradient: CanvasGradient | null = null;
  const upColor = '#26a69a';
  const downColor = '#ef5350';

  if (isVolume && !isThinBar) {
    const volHeight = plotRect.height * 0.2;
    const volBottom = plotRect.y + plotRect.height;
    const volTop = volBottom - volHeight;

    upGradient = ctx.createLinearGradient(0, volTop, 0, volBottom);
    upGradient.addColorStop(0, upColor);
    upGradient.addColorStop(1, applyAlpha(upColor, 0.2));

    downGradient = ctx.createLinearGradient(0, volTop, 0, volBottom);
    downGradient.addColorStop(0, downColor);
    downGradient.addColorStop(1, applyAlpha(downColor, 0.2));
  }

  // Pre-calculate solid colors for thin mode
  const solidUpColor = isThinBar ? applyAlpha(upColor, 0.85) : upColor;
  const solidDownColor = isThinBar ? applyAlpha(downColor, 0.85) : downColor;

  // V10: Pixel-Perfect Aggregation for High Density
  // If bars are thinner than 1px (or very close), we bucket them by physical pixel x-coordinate.
  // This ensures 1) No gaps, 2) No moire, 3) Constant number of draw calls (max screen width).

  const useBucketing = isThinBar; // Use bucketing mainly when bars are very thin

  if (useBucketing) {
    // Map: Pixel X -> { top (minY), color }
    // We store 'top' (visual top y-coordinate). Smaller Y is higher bar.
    // We want to preserve the PREMIER peak in each bucket.
    const buckets = new Map<number, { top: number, color: string }>();

    let lastColor = '';
    const count = Math.min(time.length, value.length);

    // 1. Aggregation Phase
    for (let i = 0; i < count; i += 1) {
      const v = value[i]!;
      if (!Number.isFinite(v)) continue;

      // Calculate Y
      let yValue: number;
      if (isVolume) {
        yValue = volBottom - (v / safeMaxVolume) * volHeight;
      } else {
        const scaled = scaleMode === 'normal' ? v : applyPriceScaleMode(v, scaleMode, scaleBase);
        const valY = priceScale.valueToY(scaled);
        if (!Number.isFinite(valY)) continue;
        yValue = plotRect.y + valY;
      }

      const t = time[i]!;
      const center = offsetX + t * scaleX;

      // Bucket Key: Physical X pixel index
      const centerDevice = Math.round(center * safeDpr);
      // For bucketing, we can just use the center or the left edge of the column.
      // Let's use the centerDevice pixel as the key.
      const bucketKey = centerDevice;

      const y = alignToDevicePixel(yValue, safeDpr);
      const top = Math.min(y, baselineY);
      // const bottom = Math.max(y, baselineY); // Baseline is constant per loop usually

      const override = colorResolver ? colorResolver(t, i) : null;
      let fill = override ?? defaultColor;

      // Resolve Volume Color
      if (isVolume) {
        const isUp = fill.includes('38, 166, 154') || fill.includes('26a69a') || fill.includes('0, 150, 136');
        // Use solid color for thin/bucketed mode
        fill = isUp ? solidUpColor : solidDownColor;
      }

      // Update Bucket
      const existing = buckets.get(bucketKey);
      if (!existing) {
        buckets.set(bucketKey, { top, color: fill });
      } else {
        // Keep the "Tallest" bar (Smallest Top Y)
        if (top < existing.top) {
          existing.top = top;
          existing.color = fill; // The peak defines the color (usually)
        }
      }
    }

    // 2. Rendering Phase
    // Iterate buckets and draw 1px wide bars
    // We need to sort keys? Map insertion order is usually preserve, but X order is better.
    // Since input is sorted by time, keys should be roughly sorted.
    // But for drawing, order doesn't matter for non-overlapping solid bars.

    // We draw columns 1 physical pixel wide.
    const onePixel = 1 / safeDpr;

    for (const [deviceX, data] of buckets) {
      const left = deviceX / safeDpr; // deviceX is center?
      // Actually, if deviceX is center, we want to draw at left edge?
      // Let's align center: 
      // Rect X = (deviceX - 0.5) / DPR -> width 1/DPR.
      // Or just map deviceX to a pixel column.

      // Let's use:
      // x = (deviceX - 0.5) / safeDpr
      // width = 1 / safeDpr
      // This covers the pixel centered at deviceX.

      const rectX = (deviceX - 0.5) / safeDpr;

      // Calculate height
      const bottom = baselineY;
      const height = Math.max(onePixel, bottom - data.top); // Ensure at least 1px height

      if (data.color !== lastColor) {
        ctx.fillStyle = data.color;
        lastColor = data.color;
      }
      ctx.fillRect(rectX, data.top, onePixel, height);
    }

  } else {
    // STANDARD / ZOOMED-IN RENDERING
    let lastColor = '';
    const count = Math.min(time.length, value.length);
    for (let i = 0; i < count; i += 1) {
      const v = value[i]!;
      if (!Number.isFinite(v)) continue;

      let yValue: number;
      if (isVolume) {
        yValue = volBottom - (v / safeMaxVolume) * volHeight;
      } else {
        const scaled = scaleMode === 'normal' ? v : applyPriceScaleMode(v, scaleMode, scaleBase);
        const valY = priceScale.valueToY(scaled);
        if (!Number.isFinite(valY)) continue;
        yValue = plotRect.y + valY;
      }

      const t = time[i]!;
      const center = offsetX + t * scaleX;

      // Always use pixel-aligned positioning for consistency
      const centerDevice = Math.round(center * safeDpr);
      const leftDevice = centerDevice - halfDeviceWidth;
      const left = leftDevice / safeDpr;

      // No manual gap filling needed here as bars are wide enough

      const y = alignToDevicePixel(yValue, safeDpr);
      const top = Math.min(y, baselineY);
      const bottom = Math.max(y, baselineY);
      const height = bottom - top;

      // Prevent drawing invisible slivers (standard)
      if (height <= 0 || barWidthAligned <= 0) continue;

      const override = colorResolver ? colorResolver(t, i) : null;
      const baseFill = override ?? defaultColor;

      if (isVolume) {
        const isUp = baseFill.includes('38, 166, 154') || baseFill.includes('26a69a') || baseFill.includes('0, 150, 136');
        ctx.fillStyle = isUp ? upGradient! : downGradient!;
      } else if (baseFill !== lastColor) {
        ctx.fillStyle = baseFill;
        lastColor = baseFill;
      }
      ctx.fillRect(left, top, barWidthAligned, height);
    }
  }

  ctx.restore();
};

const applyAlpha = (color: string, alpha: number): string => {
  if (color.startsWith('rgba')) {
    return color.replace(/[\d.]+\)$/g, `${alpha})`);
  }
  if (color.startsWith('rgb')) {
    return color.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
  }
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
};
