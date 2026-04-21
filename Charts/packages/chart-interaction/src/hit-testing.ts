/**
 * Hit testing for series and drawings.
 * Provides O(1) series lookup and spatial index for drawings.
 */

import type { TimeMs, VisibleTimeRange } from '@charts-plus/chart-core';
import type { SeriesRenderData } from '@charts-plus/chart-core';
import type { Point, Drawing } from './spatial-index';
import { SpatialIndex } from './spatial-index';

/**
 * Hit test result for series.
 */
export type SeriesHitResult = {
  time: TimeMs;
  value: number | null;
  index: number;
  distance: number; // Distance from click to bar (pixels)
};

/**
 * Hit test result for drawing.
 */
export type DrawingHitResult = {
  drawing: Drawing;
  handleIndex?: number; // If a handle was hit
  distance: number; // Distance from click (pixels)
};

/**
 * Hit test options.
 */
export type HitTestOptions = {
  maxDistance?: number;      // Maximum distance for hit (pixels)
  handleRadius?: number;     // Handle hit radius (pixels)
  barWidth?: number;         // Bar width for series hit testing (pixels)
};

const DEFAULT_OPTIONS: Required<HitTestOptions> = {
  maxDistance: 10,
  handleRadius: 5,
  barWidth: 4,
};

/**
 * Hit test a series at a point.
 * Returns the nearest bar if within threshold.
 */
export function hitTestSeries(
  x: number,
  y: number,
  series: SeriesRenderData,
  timeRange: VisibleTimeRange,
  plotRect: { x: number; y: number; width: number; height: number },
  priceScale: { valueToY: (value: number) => number; yToValue: (y: number) => number },
  options: HitTestOptions = {},
): SeriesHitResult | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!series.time || series.time.length === 0) {
    return null;
  }

  // Convert screen X to time
  const timeSpan = timeRange.to - timeRange.from;
  if (timeSpan <= 0) {
    return null;
  }

  const relativeX = x - plotRect.x;
  const normalizedTime = relativeX / plotRect.width;
  const time = timeRange.from + normalizedTime * timeSpan;

  // Find nearest bar (binary search)
  let left = 0;
  let right = series.time.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (series.time[mid]! < time) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  const index = left;
  if (index >= series.time.length) {
    return null;
  }

  // Check both current and previous bar (in case we're between bars)
  let bestIndex = index;
  let bestDistance = Infinity;

  for (const candidateIndex of [index, index - 1]) {
    if (candidateIndex < 0 || candidateIndex >= series.time.length) {
      continue;
    }

    const barTime = series.time[candidateIndex]!;
    const barX = plotRect.x + ((barTime - timeRange.from) / timeSpan) * plotRect.width;
    const distanceX = Math.abs(x - barX);

    if (distanceX > opts.barWidth * 2) {
      continue; // Too far horizontally
    }

    // Check vertical distance (for OHLC, check if y is within high/low range)
    if (series.seriesType === 'candlestick' && series.high && series.low) {
      const high = series.high[candidateIndex]!;
      const low = series.low[candidateIndex]!;
      
      if (!Number.isFinite(high) || !Number.isFinite(low)) {
        continue;
      }

      const highY = plotRect.y + priceScale.valueToY(high);
      const lowY = plotRect.y + priceScale.valueToY(low);
      
      if (y < Math.min(highY, lowY) - opts.maxDistance || y > Math.max(highY, lowY) + opts.maxDistance) {
        continue; // Too far vertically
      }

      const distanceY = Math.min(Math.abs(y - highY), Math.abs(y - lowY));
      const distance = Math.sqrt(distanceX * distanceX + distanceY * distanceY);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = candidateIndex;
      }
    } else if (series.value) {
      // Line/area series
      const value = series.value[candidateIndex]!;
      if (!Number.isFinite(value)) {
        continue;
      }

      const valueY = plotRect.y + priceScale.valueToY(value);
      const distanceY = Math.abs(y - valueY);
      const distance = Math.sqrt(distanceX * distanceX + distanceY * distanceY);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = candidateIndex;
      }
    }
  }

  if (bestDistance > opts.maxDistance) {
    return null;
  }

  const resultTime = series.time[bestIndex]!;
  const resultValue = series.value ? series.value[bestIndex]! : null;

  return {
    time: resultTime,
    value: resultValue,
    index: bestIndex,
    distance: bestDistance,
  };
}

/**
 * Hit test drawings at a point.
 * Uses spatial index for efficient queries.
 */
export function hitTestDrawings(
  x: number,
  y: number,
  spatialIndex: SpatialIndex,
  options: HitTestOptions = {},
): DrawingHitResult | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const point: Point = { x, y };

  // First, check handles (smaller hit area)
  const nearest = spatialIndex.nearest(point, opts.maxDistance);
  if (!nearest) {
    return null;
  }

  // Check if point hits a handle
  if (nearest.handles) {
    for (let i = 0; i < nearest.handles.length; i++) {
      const handle = nearest.handles[i]!;
      const distance = Math.sqrt(
        Math.pow(x - handle.x, 2) + Math.pow(y - handle.y, 2),
      );

      if (distance <= opts.handleRadius) {
        return {
          drawing: nearest,
          handleIndex: i,
          distance,
        };
      }
    }
  }

  // Check if point hits the drawing bounds
  const bounds = nearest.bounds;
  if (
    x >= bounds.x &&
    x <= bounds.x + bounds.width &&
    y >= bounds.y &&
    y <= bounds.y + bounds.height
  ) {
    const centerX = bounds.x + bounds.width * 0.5;
    const centerY = bounds.y + bounds.height * 0.5;
    const distance = Math.sqrt(
      Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2),
    );

    return {
      drawing: nearest,
      distance,
    };
  }

  // Check distance to bounds
  const distance = Math.sqrt(
    Math.pow(Math.max(bounds.x - x, 0, x - (bounds.x + bounds.width)), 2) +
    Math.pow(Math.max(bounds.y - y, 0, y - (bounds.y + bounds.height)), 2),
  );

  if (distance <= opts.maxDistance) {
    return {
      drawing: nearest,
      distance,
    };
  }

  return null;
}

/**
 * Hit testing manager.
 * Combines series and drawing hit testing.
 */
export class HitTestingManager {
  private spatialIndex = new SpatialIndex(100);
  private series: SeriesRenderData[] = [];

  /**
   * Set series for hit testing.
   */
  public setSeries(series: SeriesRenderData[]): void {
    this.series = series;
  }

  /**
   * Add drawing to spatial index.
   */
  public addDrawing(drawing: Drawing): void {
    this.spatialIndex.insert(drawing);
  }

  /**
   * Remove drawing from spatial index.
   */
  public removeDrawing(drawingId: string): void {
    this.spatialIndex.remove(drawingId);
  }

  /**
   * Update drawing in spatial index.
   */
  public updateDrawing(drawing: Drawing): void {
    this.spatialIndex.update(drawing);
  }

  /**
   * Hit test at a point.
   * Returns the best match (drawing handle > drawing > series).
   */
  public hitTest(
    x: number,
    y: number,
    timeRange: VisibleTimeRange,
    plotRect: { x: number; y: number; width: number; height: number },
    priceScale: { valueToY: (value: number) => number; yToValue: (y: number) => number },
    options: HitTestOptions = {},
  ): {
    drawing?: DrawingHitResult;
    series?: SeriesHitResult;
  } {
    // Test drawings first (higher priority)
    const drawingResult = hitTestDrawings(x, y, this.spatialIndex, options);

    // Test series if no drawing hit
    let seriesResult: SeriesHitResult | null = null;
    if (!drawingResult) {
      // Test all series, return closest
      let bestSeries: SeriesHitResult | null = null;
      for (const s of this.series) {
        if (!s.visible) continue;
        const result = hitTestSeries(x, y, s, timeRange, plotRect, priceScale, options);
        if (result && (!bestSeries || result.distance < bestSeries.distance)) {
          bestSeries = result;
        }
      }
      seriesResult = bestSeries;
    }

    const result: { drawing?: DrawingHitResult; series?: SeriesHitResult } = {};
    if (drawingResult) {
      result.drawing = drawingResult;
    }
    if (seriesResult) {
      result.series = seriesResult;
    }
    return result;
  }

  /**
   * Clear all drawings.
   */
  public clear(): void {
    this.spatialIndex.clear();
  }

  /**
   * Get spatial index statistics.
   */
  public getStats() {
    return this.spatialIndex.getStats();
  }
}

