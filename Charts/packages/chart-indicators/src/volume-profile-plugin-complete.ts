/**
 * Volume Profile Plugin - Complete Implementation
 * 
 * A ChartPlugin that renders volume profile on the chart.
 * Displays volume distribution across price levels with POC, VAH, VAL lines.
 */

import type { ChartPlugin, PluginRenderState, Chart } from '@charts-plus/chart-core';
import { calculateVolumeProfile } from './volume-profile-calc';
import type { VolumeProfileData, VolumeProfileCalcOptions } from './volume-profile-calc';

export interface VolumeProfilePluginOptions extends VolumeProfileCalcOptions {
  // Display options
  displaySide?: 'left' | 'right';        // Which side to display profile (default: 'right')
  maxWidthPercent?: number;              // Max width as % of chart (default: 0.25)
  
  // Styling
  profileColor?: string;                 // Profile bar color (default: 'rgba(100, 149, 237, 0.4)')
  pocColor?: string;                     // POC line color (default: 'rgba(255, 193, 7, 0.8)')
  valueAreaColor?: string;               // Value area background color (default: 'rgba(100, 149, 237, 0.15)')
  outlineColor?: string;                 // Bar outline color (default: 'rgba(255, 255, 255, 0.2)')
  
  // Lines
  showPOCLine?: boolean;                 // Show POC line across chart (default: true)
  showVALines?: boolean;                 // Show VAH/VAL lines across chart (default: true)
  pocLineStyle?: 'solid' | 'dashed';    // POC line style (default: 'dashed')
  vaLineStyle?: 'solid' | 'dashed';     // VA line style (default: 'dashed')
  
  // Labels
  showLabels?: boolean;                  // Show POC/VAH/VAL labels (default: true)
  labelFont?: string;                    // Label font (default: 'bold 9px Inter, system-ui, sans-serif')
  
  // Update behavior
  recalculateOnViewportChange?: boolean; // Recalculate on viewport change (default: false)
}

/**
 * Volume Profile Plugin
 * 
 * Usage:
 * ```typescript
 * const plugin = createVolumeProfilePlugin({
 *   numBuckets: 48,
 *   displaySide: 'right',
 *   showPOCLine: true,
 * });
 * 
 * // Set data (OHLCV format)
 * plugin.updateData({
 *   time: Float64Array,
 *   high: Float64Array,
 *   low: Float64Array,
 *   close: Float64Array,
 *   volume: Float64Array,
 * });
 * 
 * chart.addPlugin(plugin);
 * ```
 */
export function createVolumeProfilePlugin(
  options: VolumeProfilePluginOptions = {}
): ChartPlugin<CanvasRenderingContext2D> & {
  updateData: (data: {
    time: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
    buyVolume?: Float64Array;
    sellVolume?: Float64Array;
  }) => void;
  getProfileData: () => VolumeProfileData | null;
  setRange: (startTime?: number, endTime?: number) => void;
  getRange: () => { startTime?: number; endTime?: number };
} {
  
  let profileData: VolumeProfileData | null = null;
  let cachedData: {
    time: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
    buyVolume?: Float64Array;
    sellVolume?: Float64Array;
  } | null = null;
  
  let rangeStartTime: number | undefined = options.startTime;
  let rangeEndTime: number | undefined = options.endTime;
  
  // Store chart instance for invalidation
  let chartInstance: Chart | null = null;
  
  // Cache for bar heights (per-frame cache to avoid recalculating for each bucket)
  // Heights depend on: plotRect.height (resize) and price scale state (zoom Y-axis)
  // Cache key includes plotRect.height and first/last price Y positions (proxy for price scale state)
  let cachedBarHeights: { bucketPriceSize: number; heights: number[] | null; cacheKey: string } | null = null;
  
  const {
    displaySide = 'right',
    maxWidthPercent = 0.25,
    profileColor = 'rgba(100, 149, 237, 0.4)',
    pocColor = 'rgba(255, 193, 7, 0.8)',
    valueAreaColor = 'rgba(100, 149, 237, 0.15)',
    outlineColor = 'rgba(255, 255, 255, 0.2)',
    showPOCLine = true,
    showVALines = true,
    pocLineStyle = 'dashed',
    vaLineStyle = 'dashed',
    showLabels = true,
    labelFont = 'bold 9px Inter, system-ui, sans-serif',
    recalculateOnViewportChange = false,
    numBuckets = 48,
    valueAreaPercent = 0.70,
  } = options;
  
  function recalculate(data: {
    time: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
    buyVolume?: Float64Array;
    sellVolume?: Float64Array;
  }) {
    if (!data || !data.volume || data.volume.length === 0) {
      profileData = null;
      return;
    }
    
    profileData = calculateVolumeProfile(data, {
      numBuckets,
      valueAreaPercent,
      startTime: rangeStartTime,
      endTime: rangeEndTime,
    });
    cachedData = data;
  }
  
  return {
    onInit(chart: Chart) {
      chartInstance = chart;
    },
    
    updateData(data) {
      recalculate(data);
      // Trigger chart invalidation by setting visible range to current range (forces redraw)
      // This ensures the profile is rendered immediately after data update
      if (chartInstance) {
        const currentRange = chartInstance.getVisibleTimeRange();
        chartInstance.setVisibleTimeRange(currentRange);
      }
      // Clear bar height cache since profile data changed (bucketPriceSize may have changed)
      cachedBarHeights = null;
    },
    
    setRange(startTime?: number, endTime?: number) {
      rangeStartTime = startTime;
      rangeEndTime = endTime;
      if (cachedData) {
        recalculate(cachedData);
        // Trigger invalidation
        if (chartInstance) {
          const currentRange = chartInstance.getVisibleTimeRange();
          chartInstance.setVisibleTimeRange(currentRange);
        }
      }
      // Clear bar height cache
      cachedBarHeights = null;
    },
    
    getRange() {
      return { startTime: rangeStartTime, endTime: rangeEndTime };
    },
    
    getProfileData() {
      return profileData;
    },
    
    onRenderUnderlay(ctx: CanvasRenderingContext2D, state: PluginRenderState) {
      if (!profileData || profileData.totalVolume === 0) return;
      
      const { plotRect, valueToY, snapX, snapY, visibleRange } = state;
      const { priceLevels, volumes, poc, valueAreaHigh, valueAreaLow, maxVolume, minPrice, maxPrice } = profileData;
      
      const profileWidth = plotRect.width * maxWidthPercent;
      const numBuckets = priceLevels.length;
      
      // Calculate bar height (price range per bin)
      const priceRange = maxPrice - minPrice;
      const bucketPriceSize = priceRange / numBuckets;
      
      // OPTIMIZATION: Cache bar heights per frame to avoid recalculating for each bucket
      // Heights only change when:
      //   1. Price scale changes (zoom Y-axis) - detected by checking Y positions of first/last prices
      //   2. Plot rect height changes (window resize)
      //   3. Profile data changes (minPrice/maxPrice changes) - bucketPriceSize changes
      // Create cache key based on plotRect.height and Y positions of first/last prices (proxy for price scale)
      const firstPriceY = snapY(valueToY(minPrice));
      const lastPriceY = snapY(valueToY(maxPrice));
      const cacheKey = `${plotRect.height}-${firstPriceY}-${lastPriceY}-${bucketPriceSize}`;
      let barHeights: number[] | null = null;
      
      if (cachedBarHeights?.bucketPriceSize === bucketPriceSize && cachedBarHeights?.cacheKey === cacheKey) {
        // Reuse cached heights (same price scale state and plot rect size)
        barHeights = cachedBarHeights.heights;
      } else {
        // Calculate heights once per frame for all buckets
        // This reduces valueToY calls from 3 per bucket (center + 2 bounds) to 2 per bucket (one-time setup)
        // For 48 buckets: 144 calls → 96 calls per frame (33% reduction)
        barHeights = new Array(numBuckets);
        for (let i = 0; i < numBuckets; i++) {
          const price = priceLevels[i]!;
          // Calculate height using bucket boundaries
          barHeights[i] = Math.max(1, Math.abs(
            snapY(valueToY(price - bucketPriceSize / 2)) -
            snapY(valueToY(price + bucketPriceSize / 2))
          ));
        }
        // Cache for reuse within this frame and across frames with same price scale
        cachedBarHeights = { bucketPriceSize, heights: barHeights, cacheKey };
      }
      
      ctx.save();
      
      // Determine X position based on side
      const profileStartX = displaySide === 'left' 
        ? plotRect.x 
        : plotRect.x + plotRect.width - profileWidth;
      
      // Render value area background
      if (valueAreaHigh > valueAreaLow) {
        const vahY = snapY(valueToY(valueAreaHigh));
        const valY = snapY(valueToY(valueAreaLow));
        ctx.fillStyle = valueAreaColor;
        ctx.fillRect(profileStartX, Math.min(vahY, valY), profileWidth, Math.abs(valY - vahY));
      }
      
      // Render volume bars
      for (let i = 0; i < numBuckets; i++) {
        const price = priceLevels[i]!;
        const vol = volumes[i]!;
        
        if (vol === 0) continue;
        
        const y = snapY(valueToY(price));
        // OPTIMIZATION: Use cached bar height instead of recalculating
        const barHeight = barHeights[i]!;
        
        const barWidth = (vol / maxVolume) * profileWidth;
        
        // Determine color (POC bin gets special color)
        const isPOC = Math.abs(price - poc) < bucketPriceSize / 2;
        const isInValueArea = price >= valueAreaLow && price <= valueAreaHigh;
        
        if (isPOC) {
          ctx.fillStyle = pocColor;
        } else if (isInValueArea) {
          ctx.fillStyle = valueAreaColor;
        } else {
          ctx.fillStyle = profileColor;
        }
        
        // Calculate bar position
        const barX = displaySide === 'left' 
          ? profileStartX 
          : profileStartX + profileWidth - barWidth;
        
        const barY = y - barHeight / 2;
        
        // Draw bar
        ctx.globalAlpha = isPOC ? 0.8 : 0.6;
        ctx.fillRect(barX, barY, barWidth, barHeight);
        
        // Outline
        if (outlineColor) {
          ctx.strokeStyle = outlineColor;
          ctx.lineWidth = 0.5;
          ctx.globalAlpha = 1;
          ctx.strokeRect(barX, barY, barWidth, barHeight);
        }
      }
      
      // Render POC line across entire chart
      if (showPOCLine) {
        const pocY = snapY(valueToY(poc));
        
        ctx.strokeStyle = pocColor;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 1;
        ctx.setLineDash(pocLineStyle === 'dashed' ? [6, 3] : []);
        
        ctx.beginPath();
        ctx.moveTo(snapX(plotRect.x), Math.round(pocY) + 0.5);
        ctx.lineTo(snapX(plotRect.x + plotRect.width), Math.round(pocY) + 0.5);
        ctx.stroke();
        
        // POC label
        if (showLabels) {
          renderLabel(ctx, {
            plotRect,
            profileWidth,
            displaySide,
            x: displaySide === 'left' 
              ? plotRect.x + profileWidth + 8 
              : plotRect.x + plotRect.width - profileWidth,
            y: pocY,
            text: 'POC',
            color: pocColor,
            font: labelFont,
            snapX,
          });
        }
      }
      
      // Render Value Area lines across entire chart
      if (showVALines) {
        ctx.strokeStyle = valueAreaColor;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1;
        ctx.setLineDash(vaLineStyle === 'dashed' ? [4, 2] : []);
        
        // VAH
        const vahY = snapY(valueToY(valueAreaHigh));
        ctx.beginPath();
        ctx.moveTo(snapX(plotRect.x), Math.round(vahY) + 0.5);
        ctx.lineTo(snapX(plotRect.x + plotRect.width), Math.round(vahY) + 0.5);
        ctx.stroke();
        
        if (showLabels) {
          renderLabel(ctx, {
            plotRect,
            profileWidth,
            displaySide,
            x: displaySide === 'left' 
              ? plotRect.x + profileWidth + 8 
              : plotRect.x + plotRect.width - profileWidth,
            y: vahY,
            text: 'VAH',
            color: valueAreaColor,
            font: labelFont,
            snapX,
          });
        }
        
        // VAL
        const valY = snapY(valueToY(valueAreaLow));
        ctx.beginPath();
        ctx.moveTo(snapX(plotRect.x), Math.round(valY) + 0.5);
        ctx.lineTo(snapX(plotRect.x + plotRect.width), Math.round(valY) + 0.5);
        ctx.stroke();
        
        if (showLabels) {
          renderLabel(ctx, {
            plotRect,
            profileWidth,
            displaySide,
            x: displaySide === 'left' 
              ? plotRect.x + profileWidth + 8 
              : plotRect.x + plotRect.width - profileWidth,
            y: valY,
            text: 'VAL',
            color: valueAreaColor,
            font: labelFont,
            snapX,
          });
        }
      }
      
      ctx.restore();
    },
  };
}

/**
 * Render label with background
 * OPTIMIZATION: Measures text width dynamically and positions based on display side
 */
function renderLabel(
  ctx: CanvasRenderingContext2D,
  params: { 
    plotRect: { x: number; y: number; width: number; height: number };
    profileWidth: number;
    displaySide: 'left' | 'right';
    x: number;
    y: number;
    text: string;
    color: string;
    font: string;
    snapX: (x: number) => number;
  }
): void {
  const { plotRect, profileWidth, displaySide, x, y, text, color, font, snapX } = params;
  
  // Set font first to measure text accurately
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const textWidth = ctx.measureText(text).width;
  const padding = 4;
  const labelY = Math.round(y);
  
  // OPTIMIZATION: Position label dynamically based on actual text width
  // Left side: Position to the right of profile
  // Right side: Position to the left of profile, accounting for text width
  let labelX: number;
  if (displaySide === 'left') {
    // Left side: label goes to the right of profile
    labelX = snapX(plotRect.x + profileWidth + 8);
  } else {
    // Right side: label goes to the left of profile, positioned so text doesn't overlap
    // Position at: plotRect.x + plotRect.width - profileWidth - textWidth - padding*2 - 8
    labelX = snapX(plotRect.x + plotRect.width - profileWidth - textWidth - padding * 2 - 8);
  }
  
  // Background (use roundRect if available, fallback to fillRect)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  if (typeof (ctx as any).roundRect === 'function') {
    ctx.beginPath();
    (ctx as any).roundRect(labelX, labelY - 8, textWidth + padding * 2, 16, 2);
    ctx.fill();
  } else {
    // Fallback for browsers without roundRect
    ctx.fillRect(labelX, labelY - 8, textWidth + padding * 2, 16);
  }
  
  // Text
  ctx.fillStyle = color;
  ctx.fillText(text, labelX + padding, labelY);
}

