import type { Tick, Rect, TimeScale, PriceScale } from '@charts-plus/chart-core';

export interface GridStyle {
  majorColor: string;
  minorColor: string;
  majorLineWidth: number;
  minorLineWidth: number;
}

const DEFAULT_GRID_STYLE: GridStyle = {
  majorColor: 'rgba(255, 255, 255, 0.08)',
  minorColor: 'rgba(255, 255, 255, 0.03)',
  majorLineWidth: 1,
  minorLineWidth: 1,
};

/**
 * Render grid using pre-generated ticks and scale instances.
 * 
 * KEY: Uses xScale.timeToX() and priceScale.valueToY() - THE SAME
 * functions used by candlestick renderer.
 * 
 * This is the SINGLE TRANSFORM PRINCIPLE in action:
 * - Grid uses xScale.timeToX(tick.value) for X coordinates
 * - Candlesticks use xScale.timeToX(bar.time) for X coordinates
 * - Same function = perfect alignment GUARANTEED
 * 
 * @param ctx - Canvas rendering context
 * @param xTicks - Pre-generated, cached X-axis ticks
 * @param yTicks - Pre-generated, cached Y-axis ticks
 * @param xScale - THE SAME TimeScale instance used by candlesticks
 * @param priceScale - THE SAME PriceScale instance used by candlesticks
 * @param plotRect - Plot area rectangle
 * @param style - Grid styling options
 */
export function renderGrid(
  ctx: CanvasRenderingContext2D,
  xTicks: Tick[],
  yTicks: Tick[],
  xScale: TimeScale,
  priceScale: PriceScale,
  plotRect: Rect,
  style: Partial<GridStyle> = {}
): void {
  const s = { ...DEFAULT_GRID_STYLE, ...style };

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
  ctx.clip();

  // V7: Snap to physical pixels for crisp rendering (applies to all grid lines)
  // Get DPR from context or window (canvas doesn't have devicePixelRatio property)
  // Note: In browser environment, DPR is typically accessed via window.devicePixelRatio
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  const snapToPhysicalPixel = (value: number): number => {
    // Snap to physical pixel boundary: round(value * dpr) / dpr
    const physical = Math.round(value * dpr) / dpr;
    // Center on pixel: round(physical) + 0.5
    return Math.round(physical) + 0.5;
  };

  // === MINOR LINES FIRST (DRAW UNDERNEATH) ===
  ctx.strokeStyle = s.minorColor;
  ctx.lineWidth = s.minorLineWidth;
  ctx.beginPath();

  // Vertical minor lines (time)

  for (const tick of xTicks) {
    if (tick.kind !== 'minor') continue;
    const x = plotRect.x + xScale.timeToX(tick.value);  // USES SAME TRANSFORM
    if (x < plotRect.x || x > plotRect.x + plotRect.width) continue;
    const rx = snapToPhysicalPixel(x);
    ctx.moveTo(rx, plotRect.y);
    ctx.lineTo(rx, plotRect.y + plotRect.height);
  }

  // Horizontal minor lines (price)
  for (const tick of yTicks) {
    if (tick.kind !== 'minor') continue;
    const y = plotRect.y + priceScale.valueToY(tick.value);  // USES SAME TRANSFORM
    if (y < plotRect.y || y > plotRect.y + plotRect.height) continue;
    const ry = snapToPhysicalPixel(y);
    ctx.moveTo(plotRect.x, ry);
    ctx.lineTo(plotRect.x + plotRect.width, ry);
  }

  ctx.stroke();

  // === MAJOR LINES (DRAW ON TOP) ===
  ctx.strokeStyle = s.majorColor;
  ctx.lineWidth = s.majorLineWidth;
  ctx.beginPath();

  // Vertical major lines (time)
  // V7: Snap to physical pixels for crisp rendering (uses same snapping as minor lines)
  for (const tick of xTicks) {
    if (tick.kind !== 'major') continue;
    const x = plotRect.x + xScale.timeToX(tick.value);  // USES SAME TRANSFORM
    if (x < plotRect.x || x > plotRect.x + plotRect.width) continue;
    const rx = snapToPhysicalPixel(x);
    ctx.moveTo(rx, plotRect.y);
    ctx.lineTo(rx, plotRect.y + plotRect.height);
  }

  // Horizontal major lines (price)
  // V7: Snap to physical pixels for crisp rendering (uses same snapping as minor lines)
  for (const tick of yTicks) {
    if (tick.kind !== 'major') continue;
    const y = plotRect.y + priceScale.valueToY(tick.value);  // USES SAME TRANSFORM
    if (y < plotRect.y || y > plotRect.y + plotRect.height) continue;
    const ry = snapToPhysicalPixel(y);
    ctx.moveTo(plotRect.x, ry);
    ctx.lineTo(plotRect.x + plotRect.width, ry);
  }

  ctx.stroke();
  ctx.restore();
}

/**
 * Clear grid cache (placeholder for future optimizations)
 */
export function clearGridCache(): void {
  // Intentionally empty - no cache in single-transform system
  // Grid coordinates are computed on-demand using scale transforms
}

/**
 * Legacy function for backward compatibility.
 * Use renderGrid() for new code.
 */
export function renderGridFromTicks(
  ctx: CanvasRenderingContext2D,
  plotRect: Rect,
  yTicks: Tick[],
  xTicks: Tick[],
  majorColor: string,
  minorColor: string,
  options: {
    majorAlpha?: number;
    minorAlpha?: number;
    dpr?: number;
    fadeMinors?: boolean;
    skipMinors?: boolean; // V13: Skip minor grid lines during pan for performance
  } = {},
): void {
  // Skip if no ticks
  if (yTicks.length === 0 && xTicks.length === 0) {
    return;
  }

  // V13: Skip all rendering of minor lines if skipMinors is true
  const skipMinors = options.skipMinors ?? false;

  ctx.save();

  const majorAlpha = options.majorAlpha ?? 1;
  const minorAlpha = options.minorAlpha ?? 0.65;

  ctx.translate(plotRect.x, plotRect.y);
  ctx.beginPath();
  ctx.rect(0, 0, plotRect.width, plotRect.height);
  ctx.clip();

  // Separate ticks by kind
  const xMajor = xTicks.filter(t => t.kind === 'major' || t.kind === 'edge');
  const xMinor = xTicks.filter(t => t.kind === 'minor');
  const yMajor = yTicks.filter(t => t.kind === 'major' || t.kind === 'edge');
  const yMinor = yTicks.filter(t => t.kind === 'minor');

  ctx.lineWidth = 1;
  ctx.lineCap = 'square';

  // V7: Snap to physical pixels for crisp rendering
  const dpr = options.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  const snapToPhysicalPixel = (value: number): number => {
    // Snap to physical pixel boundary: round(value * dpr) / dpr
    const physical = Math.round(value * dpr) / dpr;
    // Center on pixel: round(physical) + 0.5
    return Math.round(physical) + 0.5;
  };

  // Render minor grid first (behind major)
  // V13: Skip minor lines during pan for performance
  if (!skipMinors && minorAlpha > 0 && (xMinor.length > 0 || yMinor.length > 0)) {
    ctx.globalAlpha = minorAlpha;
    ctx.strokeStyle = minorColor;
    ctx.beginPath();

    xMinor.forEach((tick) => {
      const relativeX = tick.px - plotRect.x;
      if (relativeX >= 0 && relativeX <= plotRect.width) {
        const snappedX = snapToPhysicalPixel(relativeX);
        ctx.moveTo(snappedX, 0);
        ctx.lineTo(snappedX, plotRect.height);
      }
    });

    yMinor.forEach((tick) => {
      const relativeY = tick.px - plotRect.y;
      if (relativeY >= 0 && relativeY <= plotRect.height) {
        const snappedY = snapToPhysicalPixel(relativeY);
        ctx.moveTo(0, snappedY);
        ctx.lineTo(plotRect.width, snappedY);
      }
    });

    ctx.stroke();
  }

  // Render major grid
  // V7: Snap to physical pixels for crisp rendering (same as minor lines)
  if (xMajor.length > 0 || yMajor.length > 0) {
    ctx.globalAlpha = majorAlpha;
    ctx.strokeStyle = majorColor;
    ctx.beginPath();

    xMajor.forEach((tick) => {
      const relativeX = tick.px - plotRect.x;
      if (relativeX >= 0 && relativeX <= plotRect.width) {
        const snappedX = snapToPhysicalPixel(relativeX);
        ctx.moveTo(snappedX, 0);
        ctx.lineTo(snappedX, plotRect.height);
      }
    });

    yMajor.forEach((tick) => {
      const relativeY = tick.px - plotRect.y;
      if (relativeY >= 0 && relativeY <= plotRect.height) {
        const snappedY = snapToPhysicalPixel(relativeY);
        ctx.moveTo(0, snappedY);
        ctx.lineTo(plotRect.width, snappedY);
      }
    });

    ctx.stroke();
  }

  ctx.restore();
}
