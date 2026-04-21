# V6 Implementation Guide: Phase 4 - Volume Profile

## Overview

Volume Profile displays the distribution of trading volume at each price level. It's a powerful tool for identifying support/resistance and understanding market structure.

**Location:** `packages/chart-indicators/src/volume-profile.ts`

---

## Concepts

```
                    Volume Profile
                    ◄───────────────►
                    
Price   │████████████████████████████████████│  ← High volume = resistance
        │████████████████                    │
        │██████████████████████████████████  │  ← POC (Point of Control)
        │████████████████████████            │  ← Value Area
        │██████████████████████████████████  │  ← Value Area  
        │████████████████████                │
        │████████████████████████████████████│  ← High volume = support
        └────────────────────────────────────┘
                         Time
```

**Key Concepts:**
- **POC (Point of Control):** Price level with highest volume
- **Value Area (VA):** Price range containing ~70% of volume
- **VAH (Value Area High):** Upper bound of value area
- **VAL (Value Area Low):** Lower bound of value area

---

## Task 1: Volume Profile Calculation

### File: `packages/chart-indicators/src/volume-profile.ts`

```typescript
/**
 * Volume Profile calculation and rendering
 */

export interface VolumeProfileData {
  priceLevels: Float64Array;   // Price at center of each bucket
  volumes: Float64Array;        // Volume at each level
  buyVolumes: Float64Array;     // Buy volume at each level (optional)
  sellVolumes: Float64Array;    // Sell volume at each level (optional)
  poc: number;                  // Point of Control price
  pocVolume: number;            // Volume at POC
  valueAreaHigh: number;        // Value Area High
  valueAreaLow: number;         // Value Area Low
  totalVolume: number;          // Total volume
  maxVolume: number;            // Max volume at any level
}

export interface VolumeProfileOptions {
  // Calculation options
  numBuckets?: number;           // Number of price buckets (default: 48)
  valueAreaPercent?: number;     // Value area percentage (default: 0.70)
  
  // Time range
  startTime?: number;            // Start of profile range
  endTime?: number;              // End of profile range
  sessionBased?: boolean;        // Reset at session boundaries
  
  // Display options
  displaySide?: 'left' | 'right';
  maxWidthPercent?: number;      // Max width as % of chart (default: 0.25)
  
  // Styling
  profileColor?: string;
  pocColor?: string;
  valueAreaColor?: string;
  showPOC?: boolean;
  showValueArea?: boolean;
}

/**
 * Calculate volume profile from OHLCV data
 */
export function calculateVolumeProfile(
  data: {
    time: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
    // Optional: buy/sell volume separation
    buyVolume?: Float64Array;
    sellVolume?: Float64Array;
  },
  options: VolumeProfileOptions = {}
): VolumeProfileData {
  const {
    numBuckets = 48,
    valueAreaPercent = 0.70,
    startTime,
    endTime,
  } = options;
  
  const { time, high, low, close, volume, buyVolume, sellVolume } = data;
  
  // Determine data range
  let startIdx = 0;
  let endIdx = time.length;
  
  if (startTime !== undefined) {
    startIdx = binarySearch(time, startTime);
  }
  if (endTime !== undefined) {
    endIdx = binarySearch(time, endTime) + 1;
  }
  
  // Find price range
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  
  for (let i = startIdx; i < endIdx; i++) {
    if (high[i] > maxPrice) maxPrice = high[i];
    if (low[i] < minPrice) minPrice = low[i];
  }
  
  // Handle edge case
  if (minPrice === Infinity || maxPrice === -Infinity) {
    return createEmptyProfile(numBuckets);
  }
  
  // Add small padding to avoid edge issues
  const priceRange = maxPrice - minPrice;
  minPrice -= priceRange * 0.001;
  maxPrice += priceRange * 0.001;
  
  const bucketSize = (maxPrice - minPrice) / numBuckets;
  
  // Initialize arrays
  const volumes = new Float64Array(numBuckets);
  const buyVolumes = new Float64Array(numBuckets);
  const sellVolumes = new Float64Array(numBuckets);
  const priceLevels = new Float64Array(numBuckets);
  
  // Set price levels (center of each bucket)
  for (let i = 0; i < numBuckets; i++) {
    priceLevels[i] = minPrice + (i + 0.5) * bucketSize;
  }
  
  // Distribute volume into buckets
  for (let i = startIdx; i < endIdx; i++) {
    const barHigh = high[i];
    const barLow = low[i];
    const barVolume = volume[i];
    const barBuyVolume = buyVolume?.[i] ?? barVolume * 0.5;
    const barSellVolume = sellVolume?.[i] ?? barVolume * 0.5;
    
    // Find bucket range for this bar
    const startBucket = Math.max(0, Math.floor((barLow - minPrice) / bucketSize));
    const endBucket = Math.min(numBuckets - 1, Math.floor((barHigh - minPrice) / bucketSize));
    const bucketsInBar = endBucket - startBucket + 1;
    
    // Distribute volume evenly across buckets
    const volumePerBucket = barVolume / bucketsInBar;
    const buyVolumePerBucket = barBuyVolume / bucketsInBar;
    const sellVolumePerBucket = barSellVolume / bucketsInBar;
    
    for (let b = startBucket; b <= endBucket; b++) {
      volumes[b] += volumePerBucket;
      buyVolumes[b] += buyVolumePerBucket;
      sellVolumes[b] += sellVolumePerBucket;
    }
  }
  
  // Find POC (Point of Control)
  let maxVolume = 0;
  let pocIndex = 0;
  let totalVolume = 0;
  
  for (let i = 0; i < numBuckets; i++) {
    totalVolume += volumes[i];
    if (volumes[i] > maxVolume) {
      maxVolume = volumes[i];
      pocIndex = i;
    }
  }
  
  // Calculate Value Area (70% of volume around POC)
  const targetVolume = totalVolume * valueAreaPercent;
  let vaVolume = volumes[pocIndex];
  let vaHighIndex = pocIndex;
  let vaLowIndex = pocIndex;
  
  // Expand from POC until we have target volume
  while (vaVolume < targetVolume && (vaHighIndex < numBuckets - 1 || vaLowIndex > 0)) {
    const aboveVolume = vaHighIndex < numBuckets - 1 ? volumes[vaHighIndex + 1] : 0;
    const belowVolume = vaLowIndex > 0 ? volumes[vaLowIndex - 1] : 0;
    
    // Add the side with more volume
    if (aboveVolume >= belowVolume && vaHighIndex < numBuckets - 1) {
      vaHighIndex++;
      vaVolume += aboveVolume;
    } else if (vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += belowVolume;
    } else if (vaHighIndex < numBuckets - 1) {
      vaHighIndex++;
      vaVolume += aboveVolume;
    } else {
      break;
    }
  }
  
  return {
    priceLevels,
    volumes,
    buyVolumes,
    sellVolumes,
    poc: priceLevels[pocIndex],
    pocVolume: volumes[pocIndex],
    valueAreaHigh: priceLevels[vaHighIndex] + bucketSize / 2,
    valueAreaLow: priceLevels[vaLowIndex] - bucketSize / 2,
    totalVolume,
    maxVolume,
  };
}

function createEmptyProfile(numBuckets: number): VolumeProfileData {
  return {
    priceLevels: new Float64Array(numBuckets),
    volumes: new Float64Array(numBuckets),
    buyVolumes: new Float64Array(numBuckets),
    sellVolumes: new Float64Array(numBuckets),
    poc: 0,
    pocVolume: 0,
    valueAreaHigh: 0,
    valueAreaLow: 0,
    totalVolume: 0,
    maxVolume: 0,
  };
}

function binarySearch(arr: Float64Array, target: number): number {
  let left = 0;
  let right = arr.length - 1;
  
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (arr[mid] < target) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  
  return Math.min(left, arr.length - 1);
}
```

---

## Task 2: Volume Profile Plugin

### File: `packages/chart-indicators/src/volume-profile-plugin.ts`

```typescript
import type { ChartPlugin, PluginRenderState } from '@charts-plus/chart-core';
import { calculateVolumeProfile, VolumeProfileData, VolumeProfileOptions } from './volume-profile';

export interface VolumeProfilePluginOptions extends VolumeProfileOptions {
  // Update behavior
  recalculateOnViewportChange?: boolean;  // Default: false
  
  // Styling
  profileColor?: string;              // Default: 'rgba(100, 149, 237, 0.4)'
  pocColor?: string;                  // Default: 'rgba(255, 193, 7, 0.8)'
  valueAreaColor?: string;            // Default: 'rgba(100, 149, 237, 0.6)'
  outlineColor?: string;              // Default: 'rgba(255, 255, 255, 0.3)'
  
  // Lines
  showPOCLine?: boolean;              // Default: true
  showVALines?: boolean;              // Default: true
  pocLineStyle?: 'solid' | 'dashed';  // Default: 'dashed'
  vaLineStyle?: 'solid' | 'dashed';   // Default: 'dashed'
}

export function createVolumeProfilePlugin(
  options: VolumeProfilePluginOptions = {}
): ChartPlugin<CanvasRenderingContext2D> & {
  updateData: (data: any) => void;
  getProfileData: () => VolumeProfileData | null;
} {
  
  let profileData: VolumeProfileData | null = null;
  let cachedData: any = null;
  
  const {
    displaySide = 'left',
    maxWidthPercent = 0.25,
    profileColor = 'rgba(100, 149, 237, 0.4)',
    pocColor = 'rgba(255, 193, 7, 0.8)',
    valueAreaColor = 'rgba(100, 149, 237, 0.6)',
    outlineColor = 'rgba(255, 255, 255, 0.2)',
    showPOCLine = true,
    showVALines = true,
    pocLineStyle = 'dashed',
    vaLineStyle = 'dashed',
  } = options;
  
  function recalculate(data: any) {
    if (!data || !data.volume || data.volume.length === 0) {
      profileData = null;
      return;
    }
    
    profileData = calculateVolumeProfile(data, options);
    cachedData = data;
  }
  
  return {
    onDataUpdate(data: any) {
      recalculate(data);
    },
    
    updateData(data: any) {
      recalculate(data);
    },
    
    getProfileData() {
      return profileData;
    },
    
    onRenderUnderlay(ctx: CanvasRenderingContext2D, state: PluginRenderState) {
      if (!profileData || profileData.totalVolume === 0) return;
      
      const { plotRect, priceScale } = state;
      const { priceLevels, volumes, poc, valueAreaHigh, valueAreaLow, maxVolume } = profileData;
      
      const profileWidth = plotRect.width * maxWidthPercent;
      const numBuckets = priceLevels.length;
      
      // Calculate bar height
      const priceRange = priceLevels[numBuckets - 1] - priceLevels[0];
      const bucketPriceSize = priceRange / (numBuckets - 1);
      
      ctx.save();
      
      // Determine X position based on side
      const profileStartX = displaySide === 'left' 
        ? plotRect.x 
        : plotRect.x + plotRect.width - profileWidth;
      
      // Render volume bars
      for (let i = 0; i < numBuckets; i++) {
        const price = priceLevels[i];
        const vol = volumes[i];
        
        if (vol === 0) continue;
        
        const y = priceScale.priceToY(price);
        const barHeight = Math.max(1, Math.abs(
          priceScale.priceToY(price - bucketPriceSize / 2) -
          priceScale.priceToY(price + bucketPriceSize / 2)
        ));
        
        const barWidth = (vol / maxVolume) * profileWidth;
        
        // Determine color
        const isInValueArea = price >= valueAreaLow && price <= valueAreaHigh;
        const isPOC = Math.abs(price - poc) < bucketPriceSize / 2;
        
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
        ctx.fillRect(barX, barY, barWidth, barHeight);
        
        // Outline
        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(barX, barY, barWidth, barHeight);
      }
      
      // Render POC line
      if (showPOCLine) {
        const pocY = priceScale.priceToY(poc);
        
        ctx.strokeStyle = pocColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(pocLineStyle === 'dashed' ? [6, 3] : []);
        
        ctx.beginPath();
        ctx.moveTo(plotRect.x, Math.round(pocY) + 0.5);
        ctx.lineTo(plotRect.x + plotRect.width, Math.round(pocY) + 0.5);
        ctx.stroke();
        
        // POC label
        renderLabel(ctx, {
          x: displaySide === 'left' 
            ? plotRect.x + profileWidth + 4 
            : plotRect.x + plotRect.width - profileWidth - 40,
          y: pocY,
          text: 'POC',
          color: pocColor,
        });
      }
      
      // Render Value Area lines
      if (showVALines) {
        ctx.strokeStyle = valueAreaColor;
        ctx.lineWidth = 1;
        ctx.setLineDash(vaLineStyle === 'dashed' ? [4, 2] : []);
        
        // VAH
        const vahY = priceScale.priceToY(valueAreaHigh);
        ctx.beginPath();
        ctx.moveTo(plotRect.x, Math.round(vahY) + 0.5);
        ctx.lineTo(plotRect.x + plotRect.width, Math.round(vahY) + 0.5);
        ctx.stroke();
        
        renderLabel(ctx, {
          x: displaySide === 'left' 
            ? plotRect.x + profileWidth + 4 
            : plotRect.x + plotRect.width - profileWidth - 40,
          y: vahY,
          text: 'VAH',
          color: valueAreaColor,
        });
        
        // VAL
        const valY = priceScale.priceToY(valueAreaLow);
        ctx.beginPath();
        ctx.moveTo(plotRect.x, Math.round(valY) + 0.5);
        ctx.lineTo(plotRect.x + plotRect.width, Math.round(valY) + 0.5);
        ctx.stroke();
        
        renderLabel(ctx, {
          x: displaySide === 'left' 
            ? plotRect.x + profileWidth + 4 
            : plotRect.x + plotRect.width - profileWidth - 40,
          y: valY,
          text: 'VAL',
          color: valueAreaColor,
        });
      }
      
      ctx.restore();
    },
  };
}

function renderLabel(
  ctx: CanvasRenderingContext2D,
  params: { x: number; y: number; text: string; color: string }
): void {
  const { x, y, text, color } = params;
  
  ctx.font = 'bold 9px Inter, system-ui, sans-serif';
  const textWidth = ctx.measureText(text).width;
  
  // Background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.beginPath();
  ctx.roundRect(x, y - 8, textWidth + 8, 16, 2);
  ctx.fill();
  
  // Text
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 4, y);
}
```

---

## Task 3: Session-Based Volume Profile

### File: `packages/chart-indicators/src/session-volume-profile.ts`

```typescript
import { calculateVolumeProfile, VolumeProfileData, VolumeProfileOptions } from './volume-profile';

export interface SessionVolumeProfileOptions extends VolumeProfileOptions {
  sessionStartHour?: number;   // UTC hour (default: 0)
  sessionEndHour?: number;     // UTC hour (default: 24)
  timezone?: string;           // IANA timezone (default: 'UTC')
}

export interface SessionProfiles {
  sessions: Array<{
    date: string;               // YYYY-MM-DD
    startTime: number;
    endTime: number;
    profile: VolumeProfileData;
  }>;
  composite: VolumeProfileData;  // Composite of all sessions
}

/**
 * Calculate volume profiles for each trading session
 */
export function calculateSessionVolumeProfiles(
  data: {
    time: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
  },
  options: SessionVolumeProfileOptions = {}
): SessionProfiles {
  const {
    sessionStartHour = 0,
    sessionEndHour = 24,
    timezone = 'UTC',
  } = options;
  
  const { time } = data;
  
  if (time.length === 0) {
    return {
      sessions: [],
      composite: calculateVolumeProfile(data, options),
    };
  }
  
  // Group bars by session
  const sessionBoundaries: Array<{ date: string; startIdx: number; endIdx: number }> = [];
  
  let currentSessionDate: string | null = null;
  let sessionStartIdx = 0;
  
  for (let i = 0; i < time.length; i++) {
    const date = new Date(time[i]);
    const dateStr = date.toISOString().split('T')[0];
    const hour = date.getUTCHours();
    
    // Check if we're in a new session
    const isInSession = hour >= sessionStartHour && hour < sessionEndHour;
    
    if (isInSession && dateStr !== currentSessionDate) {
      // Start new session
      if (currentSessionDate !== null) {
        sessionBoundaries.push({
          date: currentSessionDate,
          startIdx: sessionStartIdx,
          endIdx: i,
        });
      }
      currentSessionDate = dateStr;
      sessionStartIdx = i;
    }
  }
  
  // Add last session
  if (currentSessionDate !== null) {
    sessionBoundaries.push({
      date: currentSessionDate,
      startIdx: sessionStartIdx,
      endIdx: time.length,
    });
  }
  
  // Calculate profile for each session
  const sessions = sessionBoundaries.map(({ date, startIdx, endIdx }) => {
    const sessionData = {
      time: data.time.slice(startIdx, endIdx),
      high: data.high.slice(startIdx, endIdx),
      low: data.low.slice(startIdx, endIdx),
      close: data.close.slice(startIdx, endIdx),
      volume: data.volume.slice(startIdx, endIdx),
    };
    
    return {
      date,
      startTime: time[startIdx],
      endTime: time[endIdx - 1],
      profile: calculateVolumeProfile(sessionData, options),
    };
  });
  
  // Calculate composite profile
  const composite = calculateVolumeProfile(data, options);
  
  return { sessions, composite };
}
```

---

## Task 4: Fixed Range Volume Profile

### File: `packages/chart-indicators/src/fixed-range-volume-profile.ts`

```typescript
import type { ChartPlugin, PluginRenderState, PluginPointerEvent } from '@charts-plus/chart-core';
import { calculateVolumeProfile, VolumeProfileData, VolumeProfileOptions } from './volume-profile';

export interface FixedRangeVolumeProfileOptions extends VolumeProfileOptions {
  // Range selection
  startTime?: number;
  endTime?: number;
  
  // Interactivity
  allowResize?: boolean;      // Allow resizing the range
  allowMove?: boolean;        // Allow moving the range
  
  // Callbacks
  onRangeChange?: (startTime: number, endTime: number) => void;
}

/**
 * Fixed Range Volume Profile - user can select a time range
 */
export function createFixedRangeVolumeProfilePlugin(
  options: FixedRangeVolumeProfileOptions = {}
): ChartPlugin<CanvasRenderingContext2D> & {
  setRange: (startTime: number, endTime: number) => void;
  getRange: () => { startTime: number; endTime: number } | null;
  getProfileData: () => VolumeProfileData | null;
} {
  
  let profileData: VolumeProfileData | null = null;
  let cachedData: any = null;
  let startTime = options.startTime;
  let endTime = options.endTime;
  
  // Interaction state
  let isDragging = false;
  let dragType: 'move' | 'resize-start' | 'resize-end' | null = null;
  let dragStartX = 0;
  let dragStartTime = 0;
  
  const {
    displaySide = 'right',
    maxWidthPercent = 0.20,
    allowResize = true,
    allowMove = true,
  } = options;
  
  function recalculate(data: any) {
    if (!data || !startTime || !endTime) {
      profileData = null;
      return;
    }
    
    profileData = calculateVolumeProfile(data, {
      ...options,
      startTime,
      endTime,
    });
    cachedData = data;
  }
  
  return {
    setRange(newStartTime: number, newEndTime: number) {
      startTime = newStartTime;
      endTime = newEndTime;
      if (cachedData) {
        recalculate(cachedData);
      }
      options.onRangeChange?.(startTime, endTime);
    },
    
    getRange() {
      if (startTime === undefined || endTime === undefined) return null;
      return { startTime, endTime };
    },
    
    getProfileData() {
      return profileData;
    },
    
    onDataUpdate(data: any) {
      cachedData = data;
      recalculate(data);
    },
    
    onRenderUnderlay(ctx: CanvasRenderingContext2D, state: PluginRenderState) {
      if (!profileData || !startTime || !endTime) return;
      
      const { plotRect, priceScale, timeScale } = state;
      
      // Draw range highlight
      const startX = timeScale.timeToX(startTime);
      const endX = timeScale.timeToX(endTime);
      
      ctx.save();
      
      // Range background
      ctx.fillStyle = 'rgba(100, 149, 237, 0.05)';
      ctx.fillRect(startX, plotRect.y, endX - startX, plotRect.height);
      
      // Range borders
      ctx.strokeStyle = 'rgba(100, 149, 237, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 2]);
      
      ctx.beginPath();
      ctx.moveTo(Math.round(startX) + 0.5, plotRect.y);
      ctx.lineTo(Math.round(startX) + 0.5, plotRect.y + plotRect.height);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(Math.round(endX) + 0.5, plotRect.y);
      ctx.lineTo(Math.round(endX) + 0.5, plotRect.y + plotRect.height);
      ctx.stroke();
      
      // Render profile (same as regular volume profile)
      // ... (reuse rendering logic from volume-profile-plugin.ts)
      
      ctx.restore();
    },
    
    onPointer(event: PluginPointerEvent, state: PluginRenderState) {
      if (!startTime || !endTime || (!allowResize && !allowMove)) return;
      
      const { x, y, type } = event;
      const { timeScale, plotRect } = state;
      
      const startX = timeScale.timeToX(startTime);
      const endX = timeScale.timeToX(endTime);
      
      switch (type) {
        case 'move':
          if (isDragging && dragType) {
            const currentTime = timeScale.xToTime(x);
            const deltaTime = currentTime - dragStartTime;
            
            if (dragType === 'move') {
              const newStart = startTime + deltaTime;
              const newEnd = endTime + deltaTime;
              this.setRange(newStart, newEnd);
            } else if (dragType === 'resize-start') {
              this.setRange(startTime + deltaTime, endTime);
            } else if (dragType === 'resize-end') {
              this.setRange(startTime, endTime + deltaTime);
            }
            
            dragStartTime = currentTime;
          }
          break;
          
        case 'down':
          // Check if near borders (resize) or inside (move)
          if (Math.abs(x - startX) < 8 && allowResize) {
            isDragging = true;
            dragType = 'resize-start';
            dragStartX = x;
            dragStartTime = timeScale.xToTime(x);
          } else if (Math.abs(x - endX) < 8 && allowResize) {
            isDragging = true;
            dragType = 'resize-end';
            dragStartX = x;
            dragStartTime = timeScale.xToTime(x);
          } else if (x > startX && x < endX && allowMove) {
            isDragging = true;
            dragType = 'move';
            dragStartX = x;
            dragStartTime = timeScale.xToTime(x);
          }
          break;
          
        case 'up':
          isDragging = false;
          dragType = null;
          break;
      }
    },
  };
}
```

---

## Task 5: Usage Example

### File: `apps/demo/src/volume-profile-demo.ts`

```typescript
import { createChart } from '@charts-plus/chart-render-canvas2d';
import { createVolumeProfilePlugin } from '@charts-plus/chart-indicators';

const chart = createChart('container', {
  // chart options
});

// Add candlestick series
const candleSeries = chart.addCandlestickSeries({
  id: 'main',
});

// Add volume profile
const volumeProfile = createVolumeProfilePlugin({
  numBuckets: 48,
  valueAreaPercent: 0.70,
  displaySide: 'left',
  maxWidthPercent: 0.25,
  showPOCLine: true,
  showVALines: true,
  pocColor: 'rgba(255, 193, 7, 0.8)',
  valueAreaColor: 'rgba(100, 149, 237, 0.6)',
  profileColor: 'rgba(100, 149, 237, 0.4)',
});

chart.addPlugin(volumeProfile);

// Load data
async function loadData() {
  const data = await fetchOHLCVData();
  candleSeries.setData(data);
  
  // Volume profile updates automatically via onDataUpdate
}

loadData();

// Get profile data
const profileData = volumeProfile.getProfileData();
if (profileData) {
  console.log('POC:', profileData.poc);
  console.log('Value Area:', profileData.valueAreaLow, '-', profileData.valueAreaHigh);
}
```

---

## Verification Checklist

- [ ] Volume distributes correctly across price buckets
- [ ] POC is the level with highest volume
- [ ] Value Area contains ~70% of volume
- [ ] Profile renders on correct side (left/right)
- [ ] POC line renders with correct color
- [ ] VAH/VAL lines render correctly
- [ ] Labels display correctly
- [ ] Fixed range profile works
- [ ] Session-based profiles work
- [ ] Performance: <10ms for 10k bars

---

## Performance Considerations

1. **Bucket count:** 48 buckets is a good balance (fewer = faster, more = detailed)
2. **Caching:** Cache profile data, only recalculate when data changes
3. **Viewport-based:** Option to only calculate for visible range
4. **Web Worker:** For very large datasets, calculate in worker

---

## Next Steps

After completing Phase 4:
1. Test with real market data
2. Compare POC/VA with TradingView
3. Proceed to Phase 5: Polish Features
