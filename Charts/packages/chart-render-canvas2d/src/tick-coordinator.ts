/**
 * TickCoordinator - Centralized tick generation and caching
 * 
 * Single source of truth for X and Y tick generation with smart caching:
 * - Regenerates tick VALUES on zoom (>5% span change)
 * - Regenerates tick PIXEL POSITIONS on every frame (pan updates)
 * - Eliminates duplication across renderLayout, renderUnderlay, drawUnderlay
 */

import type { Tick, PaneId, Rect } from '@charts-plus/chart-core';
import type { TimeScale, PriceScale } from '@charts-plus/chart-core';
import type { SnapSurface } from './line-series-renderer';

type CachedXTicks = {
  ticks: Tick[];
  span: number;
  rangeFrom: number; // Track range boundaries to detect pan
  rangeTo: number;
  plotWidth: number; // Track plot width to detect resize
  visibleFrom: number; // Visible range used to generate ticks
  visibleTo: number;
  stepMs: number | null; // Estimated major tick spacing
};

type CachedYTicks = {
  ticks: Tick[];
  span: number;
  rangeMin: number; // Track range boundaries to detect pan
  rangeMax: number;
  plotHeight: number; // Track pane height to detect resize
};

const ZOOM_THRESHOLD = 0.05; // 5% span change triggers regeneration

const estimateTickStepMs = (ticks: Tick[]): number | null => {
  const majors = ticks.filter((tick) => tick.kind === 'major' || tick.kind === 'edge');
  if (majors.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < majors.length; i += 1) {
    const prev = majors[i - 1]?.value ?? null;
    const next = majors[i]?.value ?? null;
    if (!Number.isFinite(prev) || !Number.isFinite(next)) continue;
    const delta = Math.abs(next - prev);
    if (Number.isFinite(delta) && delta > 0) {
      deltas.push(delta);
    }
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas[mid] ?? null;
};

export class TickCoordinator {
  private cachedXTicks: CachedXTicks | null = null;
  private cachedYTicksByPane = new Map<string, CachedYTicks>();
  
  /**
   * Get X-axis ticks with smart caching.
   * Regenerates tick VALUES on zoom, but always computes fresh pixel positions.
   */
  getXTicks(
    xScale: TimeScale,
    plotRect: Rect,
    snapSurface: SnapSurface,
    skipMinor: boolean,
    options?: {
      panActive?: boolean;
    },
  ): Tick[] {
    const visibleRange = xScale.getVisibleRange();
    const currentSpan = visibleRange.to - visibleRange.from;
    const panActive = options?.panActive ?? false;
    const panRangeMargin = panActive ? 0 : 0.1;
    const cached = this.cachedXTicks;
    
    // Check if we need to regenerate tick VALUES
    // Regenerate on: zoom (span change >5%) OR pan (range moved outside cached range)
    const widthChanged = cached ? Math.abs(plotRect.width - cached.plotWidth) > 1 : false;
    const visibleShift = cached
      ? Math.max(
        Math.abs(visibleRange.from - cached.visibleFrom),
        Math.abs(visibleRange.to - cached.visibleTo)
      )
      : 0;
    const stepThreshold = (() => {
      if (cached?.stepMs && Number.isFinite(cached.stepMs)) {
        return Math.max(1, cached.stepMs * 0.5);
      }
      return Number.isFinite(currentSpan) && currentSpan > 0 ? Math.max(1, currentSpan * 0.02) : 0;
    })();
    const shouldShiftRegenerate = !panActive && stepThreshold > 0 && visibleShift > stepThreshold;
    const spanChanged = cached && Number.isFinite(cached.span) && cached.span > 0
      ? Math.abs(currentSpan - cached.span) / cached.span > ZOOM_THRESHOLD
      : true;
    const shouldRegenerate = !cached ||
      widthChanged ||
      spanChanged ||
      shouldShiftRegenerate ||
      // Check if visible range has moved outside cached tick range (pan detection)
      // Use margin to avoid unnecessary regeneration for small movements
      (cached &&
        cached.ticks.length > 0 &&
        cached.rangeTo > cached.rangeFrom &&
        (visibleRange.from < cached.rangeFrom - (cached.rangeTo - cached.rangeFrom) * panRangeMargin ||
          visibleRange.to > cached.rangeTo + (cached.rangeTo - cached.rangeFrom) * panRangeMargin));
    
    let baseTicks: Tick[];
    
    if (shouldRegenerate) {
      // Regenerate tick VALUES using scale's generateTicks
      if ('generateTicks' in xScale && typeof xScale.generateTicks === 'function') {
        baseTicks = (xScale as any).generateTicks(
          (t: number) => snapSurface.snapX(plotRect.x + xScale.timeToX(t)),
          {
            targetMajorPx: 100,
            minMajorPx: 70,
            maxMajorPx: 150,
            showMinors: !skipMinor,
            minMinorPx: 20,
          }
        );
      } else {
        baseTicks = [];
      }
      
      // Cache the tick VALUES (not pixel positions) along with range boundaries
      // Find the actual range covered by the generated ticks
      const tickValues = baseTicks.map(t => t.value).filter(v => Number.isFinite(v));
      const tickRangeFrom = tickValues.length > 0 ? Math.min(...tickValues) : visibleRange.from;
      const tickRangeTo = tickValues.length > 0 ? Math.max(...tickValues) : visibleRange.to;
      
      this.cachedXTicks = {
        ticks: baseTicks,
        span: currentSpan,
        rangeFrom: tickRangeFrom,
        rangeTo: tickRangeTo,
        plotWidth: plotRect.width,
        visibleFrom: visibleRange.from,
        visibleTo: visibleRange.to,
        stepMs: estimateTickStepMs(baseTicks),
      };
    } else {
      // Reuse cached tick VALUES
      baseTicks = cached!.ticks;
    }
    
    // Always regenerate pixel positions using current scale (includes pan offset)
    // Use overscan to ensure grid is fully rendered during pan (50% overscan on each side)
    const overscanPx = plotRect.width * 0.5;
    const minX = plotRect.x - overscanPx;
    const maxX = plotRect.x + plotRect.width + overscanPx;
    
    return baseTicks.map((tick) => {
      const freshX = plotRect.x + xScale.timeToX(tick.value);
      return {
        value: tick.value,
        px: snapSurface.snapX(freshX),
        kind: tick.kind,
        label: tick.label ?? '',
      };
    }).filter((tick) => {
      // Include ticks within visible area + overscan to ensure grid loads ahead during pan
      return tick.px >= minX && tick.px <= maxX;
    });
  }
  
  /**
   * Get Y-axis ticks with smart caching.
   * Regenerates tick VALUES on zoom, but always computes fresh pixel positions.
   */
  getYTicks(
    paneId: PaneId,
    priceScale: PriceScale,
    paneRect: Rect,
    snapSurface: SnapSurface,
    skipMinor: boolean,
    options?: {
      targetMajorPx?: number;
      minMajorPx?: number;
      maxMajorPx?: number;
      minMinorPx?: number;
      tickSize?: number;
      useFinancialNice?: boolean;
      axis?: 'left' | 'right'; // Optional axis identifier for separate left/right caching
      panActive?: boolean;
    },
  ): Tick[] {
    const range = priceScale.getRange();
    const currentSpan = range.max - range.min;
    const panActive = options?.panActive ?? false;
    const panRangeMargin = panActive ? 0 : 0.1;
    
    if (currentSpan <= 0) {
      return [];
    }
    
    // Use axis identifier if provided to cache left/right separately
    const cacheKey = options?.axis ? `${paneId}-${options.axis}` : `${paneId}`;
    const cached = this.cachedYTicksByPane.get(cacheKey);
    
    // Check if we need to regenerate tick VALUES
    // Regenerate on: zoom (span change >5%) OR pan (range moved outside cached range)
    const heightChanged = cached ? Math.abs(paneRect.height - cached.plotHeight) > 1 : false;
    const shouldRegenerate = !cached ||
      heightChanged ||
      Math.abs(currentSpan - cached.span) / cached.span > ZOOM_THRESHOLD ||
      // Check if visible range has moved outside cached tick range (pan detection)
      // Use margin to avoid unnecessary regeneration for small movements
      (cached.ticks.length > 0 && cached.rangeMax > cached.rangeMin && (
        range.min < cached.rangeMin - (cached.rangeMax - cached.rangeMin) * panRangeMargin ||
        range.max > cached.rangeMax + (cached.rangeMax - cached.rangeMin) * panRangeMargin
      ));
    
    let baseTicks: Tick[];
    
    if (shouldRegenerate) {
      // Regenerate tick VALUES using scale's generateTicks
      baseTicks = priceScale.generateTicks(
        (v) => snapSurface.snapY(paneRect.y + priceScale.valueToY(v)),
        {
          targetMajorPx: options?.targetMajorPx ?? 80,
          minMajorPx: options?.minMajorPx ?? 50,
          maxMajorPx: options?.maxMajorPx ?? 120,
          showMinors: !skipMinor,
          minMinorPx: options?.minMinorPx ?? 12,
          tickSize: options?.tickSize ?? 0,
          useFinancialNice: options?.useFinancialNice ?? true,
        }
      );
      
      // Cache the tick VALUES (not pixel positions) along with range boundaries
      const tickValues = baseTicks.map(t => t.value).filter(v => Number.isFinite(v));
      const tickRangeMin = tickValues.length > 0 ? Math.min(...tickValues) : range.min;
      const tickRangeMax = tickValues.length > 0 ? Math.max(...tickValues) : range.max;
      
      this.cachedYTicksByPane.set(cacheKey, {
        ticks: baseTicks,
        span: currentSpan,
        rangeMin: tickRangeMin,
        rangeMax: tickRangeMax,
        plotHeight: paneRect.height,
      });
    } else {
      // Reuse cached tick VALUES
      baseTicks = cached!.ticks;
    }
    
    // Always regenerate pixel positions using current scale (includes pan offset)
    // Use overscan to ensure grid is fully rendered during pan (50% overscan on each side)
    const overscanPx = paneRect.height * 0.5;
    const minY = paneRect.y - overscanPx;
    const maxY = paneRect.y + paneRect.height + overscanPx;
    
    return baseTicks.map((tick) => {
      const freshY = paneRect.y + priceScale.valueToY(tick.value);
      return {
        value: tick.value,
        px: snapSurface.snapY(freshY),
        kind: tick.kind,
        label: tick.label ?? '',
      };
    }).filter((tick) => {
      // Include ticks within visible pane area + overscan to ensure grid loads ahead during pan
      return tick.px >= minY && tick.px <= maxY;
    });
  }
  
  /**
   * Invalidate caches when zoom changes significantly.
   * Called explicitly on zoom operations.
   */
  invalidateOnZoom(): void {
    this.cachedXTicks = null;
    this.cachedYTicksByPane.clear();
  }
  
  /**
   * Invalidate all caches.
   * Called on layout changes or explicit cache clears.
   */
  invalidateAll(): void {
    this.cachedXTicks = null;
    this.cachedYTicksByPane.clear();
  }
}
