# Delta Charting Engine: Optimal Grid Background Implementation

## Complete Implementation Guide for Cursor

**Author:** Delta Plus Engineering  
**Version:** 2.0 (Production-Grade)  
**Target:** WebGPU-ready Canvas2D with TypeScript

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Core Philosophy](#2-the-core-philosophy)
3. [Coordinate System Architecture](#3-coordinate-system-architecture)
4. [The Nice Numbers Algorithm](#4-the-nice-numbers-algorithm)
5. [Hysteresis: The Secret to Smooth Zoom](#5-hysteresis-the-secret-to-smooth-zoom)
6. [Tick Generation System](#6-tick-generation-system)
7. [Time Scale (X-Axis) Special Handling](#7-time-scale-x-axis-special-handling)
8. [Minor Gridlines and Fade Logic](#8-minor-gridlines-and-fade-logic)
9. [Rendering Pipeline](#9-rendering-pipeline)
10. [Cross-Fade Transitions](#10-cross-fade-transitions)
11. [Device Pixel Ratio Handling](#11-device-pixel-ratio-handling)
12. [Complete TypeScript Implementation](#12-complete-typescript-implementation)
13. [Integration Checklist](#13-integration-checklist)

---

## 1. Executive Summary

### The Problem You're Solving

You need a grid that:
1. **Zooms intelligently** - Expands/contracts with "nice" intervals (100, 200, 500, not 137.5)
2. **Pans seamlessly** - Moves perfectly "glued" to candlesticks
3. **Aligns precisely** - Grid lines ALWAYS touch axis labels

### The Solution in One Sentence

> **The grid is not its own system. Grid lines are a visual rendering of axis tick marks.**

This single architectural decision guarantees all three requirements by construction.

### TradingView's Own Documentation States:

> "The grid is vertical/horizontal lines drawn at the levels of **visible marks** of the **price** and **time** scales."

If you implement the grid as "a thing that draws lines," you will fight alignment bugs forever. If you implement it as "render the axis ticks as lines," alignment is mathematically guaranteed.

---

## 2. The Core Philosophy

### The Golden Rule

```
┌─────────────────────────────────────────────────────────────────────┐
│                    THE GRID IS DATA, NOT UI                         │
│                                                                     │
│  Grid lines exist in DATA SPACE (price/time), not SCREEN SPACE.    │
│  They are transformed to pixels using the SAME math as candlesticks.│
│  This is why they move "glued together" during pan.                 │
└─────────────────────────────────────────────────────────────────────┘
```

### What Happens During Pan vs Zoom

| Action | What Changes | Grid Behavior |
|--------|--------------|---------------|
| **Pan** | Viewport offset (translation) | Grid slides. Step unchanged. Lines at same data values, different screen positions. |
| **Zoom** | Viewport scale | Grid adapts. Step may change. Nice Numbers algorithm selects new interval. |
| **Y-Axis Stretch** | Y scale only | Horizontal grid adapts. Vertical grid unchanged. |

### The Single Source of Truth

```
                    ┌─────────────────┐
                    │   TICK STATE    │
                    │  (majorStep,    │
                    │   minorStep,    │
                    │   positions[])  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │  GRID    │   │  AXIS    │   │ CROSSHAIR│
        │ RENDERER │   │ RENDERER │   │  SNAP    │
        └──────────┘   └──────────┘   └──────────┘
```

All three components consume the SAME tick array. This is non-negotiable.

---

## 3. Coordinate System Architecture

### The Three Spaces

```typescript
/**
 * COORDINATE SPACES
 * 
 * 1. DATA SPACE (World)
 *    - X: Unix timestamp (seconds or milliseconds) or bar index
 *    - Y: Price value (e.g., 3150.50)
 *    - Unbounded, continuous
 * 
 * 2. LOGICAL SPACE (optional intermediate)
 *    - Handles session gaps, extended hours, etc.
 *    - For simple charts, this equals data space
 * 
 * 3. SCREEN SPACE (Pixels)
 *    - X: 0 to canvasWidth
 *    - Y: 0 to canvasHeight (Y is INVERTED: 0 at top)
 *    - Bounded by viewport
 */
```

### The Transform Functions

These two functions are the foundation of EVERYTHING:

```typescript
interface Scale {
  // Visible range in data units
  dataMin: number;
  dataMax: number;
  
  // Viewport size in pixels
  pxSize: number;
  
  // Derived (computed once per frame, cached)
  pxPerUnit: number;  // = pxSize / (dataMax - dataMin)
  unitPerPx: number;  // = (dataMax - dataMin) / pxSize
}

/**
 * Converts a data value to screen pixels.
 * 
 * For Y-axis (price): Higher price = LOWER screen Y (inverted)
 * For X-axis (time): Later time = HIGHER screen X
 */
function dataToPx(value: number, scale: Scale, invert: boolean = false): number {
  const normalized = (value - scale.dataMin) / (scale.dataMax - scale.dataMin);
  if (invert) {
    // Y-axis: flip so higher values are at top of screen
    return scale.pxSize * (1 - normalized);
  }
  return scale.pxSize * normalized;
}

/**
 * Converts screen pixels to data value.
 */
function pxToData(px: number, scale: Scale, invert: boolean = false): number {
  let normalized = px / scale.pxSize;
  if (invert) {
    normalized = 1 - normalized;
  }
  return scale.dataMin + normalized * (scale.dataMax - scale.dataMin);
}
```

### Why This Guarantees "Glued" Movement

During PAN:
- `dataMin` and `dataMax` both shift by the same amount
- `dataMax - dataMin` (the range) stays constant
- `pxPerUnit` stays constant
- Grid line at price 3100 was at pixel Y=200, now it's at Y=180
- Candlestick at price 3100 was at pixel Y=200, now it's at Y=180
- **They moved identically because they use the same math**

---

## 4. The Nice Numbers Algorithm

### The Problem

If visible price range is 3000-3200 (range = 200) and you want ~10 grid lines, raw step = 20.

But you don't want lines at 3000, 3020, 3040... You want 3000, 3025, 3050 or 3000, 3050, 3100.

### The 1-2-5 System

The "nice" numbers are: **1, 2, 5** multiplied by any power of 10.

This gives: 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000...

```typescript
/**
 * Finds the nearest "nice" step to a raw step value.
 * 
 * Nice steps are (1 | 2 | 5) × 10^k
 * 
 * @param rawStep - The ideal step based on range/targetCount
 * @returns The nearest nice step
 */
function niceStep(rawStep: number): number {
  if (rawStep <= 0) return 1;
  
  // Get the magnitude (power of 10)
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = Math.pow(10, exponent);
  
  // Get the fraction (1.0 to 9.999...)
  const fraction = rawStep / magnitude;
  
  // Snap to nearest nice fraction
  let niceFraction: number;
  if (fraction <= 1.5) {
    niceFraction = 1;
  } else if (fraction <= 3.5) {
    niceFraction = 2;
  } else if (fraction <= 7.5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }
  
  return niceFraction * magnitude;
}
```

### Extended Financial Nice Numbers

For financial charts, you may want additional "nice" values like 0.25 (quarter points), 25, 250:

```typescript
/**
 * Extended nice numbers optimized for financial instruments.
 * Includes quarter-point increments common in stocks/forex.
 */
const FINANCIAL_NICE_LADDER = [
  // Sub-penny (forex, crypto)
  0.0001, 0.0002, 0.0005,
  0.001, 0.002, 0.005,
  
  // Cents
  0.01, 0.02, 0.025, 0.05,
  
  // Dimes / Quarters
  0.1, 0.2, 0.25, 0.5,
  
  // Dollars
  1, 2, 2.5, 5,
  10, 20, 25, 50,
  100, 200, 250, 500,
  
  // Thousands
  1000, 2000, 2500, 5000,
  10000, 20000, 25000, 50000,
  100000
];

/**
 * Finds the nearest financial nice step.
 */
function financialNiceStep(rawStep: number): number {
  // Binary search for the best fit
  let best = FINANCIAL_NICE_LADDER[0];
  let bestDist = Infinity;
  
  for (const candidate of FINANCIAL_NICE_LADDER) {
    // Use logarithmic distance for better matching
    const dist = Math.abs(Math.log10(candidate) - Math.log10(rawStep));
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  
  return best;
}
```

### Instrument Tick Size Enforcement

**Critical for financial accuracy:** If an instrument has a minimum tick size (e.g., ES futures = 0.25), grid lines MUST land on tradeable prices:

```typescript
/**
 * Quantizes a step to be a multiple of the instrument's tick size.
 * 
 * @param step - The nice step
 * @param tickSize - Instrument minimum tick (0 if none)
 * @returns Step rounded up to multiple of tickSize
 */
function quantizeToTickSize(step: number, tickSize: number): number {
  if (tickSize <= 0) return step;
  return Math.ceil(step / tickSize) * tickSize;
}
```

---

## 5. Hysteresis: The Secret to Smooth Zoom

### The Problem Without Hysteresis

Imagine `targetMajorPx = 80` (one grid line every ~80 pixels).

As you zoom slowly:
- At 79px spacing → step = 100 (too dense, should increase)
- At 81px spacing → step = 100 (ok)
- At 79px spacing → step = 200 (oh no, jumped!)
- At 81px spacing → step = 100 (jumped back!)

The grid "flickers" between steps on minor zoom adjustments.

### The Solution: Hysteresis Band

Instead of a single target, use a **band** of acceptable spacings:

```typescript
interface HysteresisConfig {
  targetPx: number;  // Ideal spacing (e.g., 80)
  minPx: number;     // Minimum acceptable (e.g., 50)
  maxPx: number;     // Maximum acceptable (e.g., 120)
}
```

**Rule:** If current step produces spacing WITHIN the band, keep it. Only change step when spacing goes OUTSIDE the band.

```typescript
/**
 * Picks the optimal step with hysteresis to prevent jitter.
 */
function pickStepWithHysteresis(
  dataMin: number,
  dataMax: number,
  pxSize: number,
  config: HysteresisConfig,
  previousStep: number | null,
  tickSize: number = 0,
  useFinancial: boolean = false
): number {
  const range = Math.abs(dataMax - dataMin);
  const pxPerUnit = pxSize / range;
  
  // If we have a previous step, check if it's still valid
  if (previousStep !== null) {
    const currentPxSpacing = previousStep * pxPerUnit;
    
    // If within band, keep current step (hysteresis)
    if (currentPxSpacing >= config.minPx && currentPxSpacing <= config.maxPx) {
      return previousStep;
    }
  }
  
  // Calculate new step
  const targetCount = Math.max(2, Math.round(pxSize / config.targetPx));
  const rawStep = range / targetCount;
  
  let step = useFinancial 
    ? financialNiceStep(rawStep) 
    : niceStep(rawStep);
  
  step = quantizeToTickSize(step, tickSize);
  
  // Ensure step produces spacing within band
  // If too dense (spacing < minPx), increase step
  // If too sparse (spacing > maxPx), decrease step
  for (let i = 0; i < 10; i++) {
    const spacing = step * pxPerUnit;
    
    if (spacing < config.minPx) {
      // Too dense - need larger step
      step = quantizeToTickSize(step * 2, tickSize);
    } else if (spacing > config.maxPx) {
      // Too sparse - need smaller step
      step = quantizeToTickSize(step / 2, tickSize);
    } else {
      break; // Within band
    }
  }
  
  return step;
}
```

### Recommended Hysteresis Values

| Axis Type | Target | Min | Max | Notes |
|-----------|--------|-----|-----|-------|
| Y (Price) | 80px | 50px | 120px | Allows comfortable label spacing |
| X (Time) | 100px | 60px | 150px | Time labels are wider |
| Minor | 25px | 12px | 40px | Subtle subdivision |

---

## 6. Tick Generation System

### The Complete Tick Generator

```typescript
interface Tick {
  value: number;      // Data value (price or time)
  px: number;         // Screen position in pixels
  kind: 'major' | 'minor' | 'edge';
  label?: string;     // Formatted label text
}

interface TickGeneratorConfig {
  // Hysteresis settings
  targetMajorPx: number;
  minMajorPx: number;
  maxMajorPx: number;
  
  // Minor grid settings
  showMinors: boolean;
  minMinorPx: number;   // Don't show minors if spacing < this
  
  // Financial settings
  tickSize: number;     // Instrument min tick (0 = none)
  useFinancialNice: boolean;
  
  // Edge ticks (TradingView's ensureEdgeTickMarksVisible)
  showEdgeTicks: boolean;
}

interface TickGeneratorState {
  majorStep: number | null;  // Cached for hysteresis
}

/**
 * Generates all ticks for a scale.
 * 
 * This is the SINGLE SOURCE OF TRUTH for both grid lines and axis labels.
 */
function generateTicks(
  dataMin: number,
  dataMax: number,
  pxSize: number,
  dataToPxFn: (v: number) => number,
  formatFn: (v: number, step: number) => string,
  config: TickGeneratorConfig,
  state: TickGeneratorState
): Tick[] {
  const ticks: Tick[] = [];
  const range = Math.abs(dataMax - dataMin);
  const pxPerUnit = pxSize / range;
  
  // ─────────────────────────────────────────────────────────────────
  // STEP 1: Pick major step with hysteresis
  // ─────────────────────────────────────────────────────────────────
  const majorStep = pickStepWithHysteresis(
    dataMin, dataMax, pxSize,
    { targetPx: config.targetMajorPx, minPx: config.minMajorPx, maxPx: config.maxMajorPx },
    state.majorStep,
    config.tickSize,
    config.useFinancialNice
  );
  state.majorStep = majorStep;
  
  // ─────────────────────────────────────────────────────────────────
  // STEP 2: Generate major ticks (anchored to 0 for stability)
  // ─────────────────────────────────────────────────────────────────
  // Start at the first multiple of majorStep >= dataMin
  const firstMajor = Math.ceil(dataMin / majorStep) * majorStep;
  const epsilon = majorStep * 1e-9; // Float tolerance
  
  for (let v = firstMajor; v <= dataMax + epsilon; v += majorStep) {
    // Round to avoid float artifacts like 3000.0000000001
    const cleanV = Math.round(v / majorStep) * majorStep;
    
    ticks.push({
      value: cleanV,
      px: dataToPxFn(cleanV),
      kind: 'major',
      label: formatFn(cleanV, majorStep)
    });
  }
  
  // ─────────────────────────────────────────────────────────────────
  // STEP 3: Generate minor ticks (if enabled and not too dense)
  // ─────────────────────────────────────────────────────────────────
  if (config.showMinors) {
    const majorPxSpacing = majorStep * pxPerUnit;
    
    // Determine minor subdivisions based on major step's "base"
    // If step = 1×10^k → 5 minors (step 0.2)
    // If step = 2×10^k → 4 minors (step 0.5)
    // If step = 5×10^k → 5 minors (step 1)
    const base = majorStep / Math.pow(10, Math.floor(Math.log10(majorStep)));
    const minorCount = (base === 2) ? 4 : 5;
    const minorStep = majorStep / minorCount;
    
    const minorPxSpacing = minorStep * pxPerUnit;
    
    // Only show minors if they're not too dense
    if (minorPxSpacing >= config.minMinorPx) {
      const firstMinor = Math.ceil(dataMin / minorStep) * minorStep;
      
      for (let v = firstMinor; v <= dataMax + epsilon; v += minorStep) {
        const cleanV = Math.round(v / minorStep) * minorStep;
        
        // Skip values that coincide with major ticks
        const isMajor = Math.abs((cleanV / majorStep) - Math.round(cleanV / majorStep)) < 1e-9;
        if (isMajor) continue;
        
        ticks.push({
          value: cleanV,
          px: dataToPxFn(cleanV),
          kind: 'minor'
        });
      }
    }
  }
  
  // ─────────────────────────────────────────────────────────────────
  // STEP 4: Edge ticks (optional, like TradingView's feature)
  // ─────────────────────────────────────────────────────────────────
  if (config.showEdgeTicks) {
    // Add tick at visible edges if not near an existing major tick
    const edgeThreshold = majorStep * 0.2; // 20% of step
    
    const nearMin = ticks.some(t => t.kind === 'major' && Math.abs(t.value - dataMin) < edgeThreshold);
    const nearMax = ticks.some(t => t.kind === 'major' && Math.abs(t.value - dataMax) < edgeThreshold);
    
    if (!nearMin) {
      ticks.push({
        value: dataMin,
        px: dataToPxFn(dataMin),
        kind: 'edge',
        label: formatFn(dataMin, majorStep)
      });
    }
    
    if (!nearMax) {
      ticks.push({
        value: dataMax,
        px: dataToPxFn(dataMax),
        kind: 'edge',
        label: formatFn(dataMax, majorStep)
      });
    }
  }
  
  return ticks;
}
```

---

## 7. Time Scale (X-Axis) Special Handling

### Why Time Is Different

For the Y-axis (price), the 1-2-5 system works perfectly.

For the X-axis (time), you need **calendar-aware intervals**:
- 1 minute, 5 minutes, 15 minutes, 30 minutes
- 1 hour, 2 hours, 4 hours
- 1 day, 1 week
- 1 month, 3 months, 6 months
- 1 year

And ticks must land on **meaningful boundaries**:
- Hour ticks at XX:00:00
- Day ticks at 00:00:00
- Month ticks on the 1st

### Time Interval Ladder

```typescript
interface TimeInterval {
  ms: number;           // Duration in milliseconds
  name: string;         // For debugging
  align: (ts: number) => number;  // Aligns timestamp to boundary
  format: (ts: number, locale?: string) => string;  // Label format
}

const TIME_INTERVALS: TimeInterval[] = [
  // Seconds
  {
    ms: 1000,
    name: '1s',
    align: (ts) => Math.floor(ts / 1000) * 1000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { second: '2-digit' })
  },
  {
    ms: 5000,
    name: '5s',
    align: (ts) => Math.floor(ts / 5000) * 5000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { minute: '2-digit', second: '2-digit' })
  },
  {
    ms: 15000,
    name: '15s',
    align: (ts) => Math.floor(ts / 15000) * 15000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { minute: '2-digit', second: '2-digit' })
  },
  {
    ms: 30000,
    name: '30s',
    align: (ts) => Math.floor(ts / 30000) * 30000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { minute: '2-digit', second: '2-digit' })
  },
  
  // Minutes
  {
    ms: 60000,
    name: '1m',
    align: (ts) => Math.floor(ts / 60000) * 60000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  },
  {
    ms: 300000,
    name: '5m',
    align: (ts) => Math.floor(ts / 300000) * 300000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  },
  {
    ms: 900000,
    name: '15m',
    align: (ts) => Math.floor(ts / 900000) * 900000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  },
  {
    ms: 1800000,
    name: '30m',
    align: (ts) => Math.floor(ts / 1800000) * 1800000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  },
  
  // Hours
  {
    ms: 3600000,
    name: '1h',
    align: (ts) => Math.floor(ts / 3600000) * 3600000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  },
  {
    ms: 7200000,
    name: '2h',
    align: (ts) => Math.floor(ts / 7200000) * 7200000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  },
  {
    ms: 14400000,
    name: '4h',
    align: (ts) => Math.floor(ts / 14400000) * 14400000,
    format: (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  },
  
  // Days
  {
    ms: 86400000,
    name: '1D',
    align: (ts) => {
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    },
    format: (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  },
  {
    ms: 604800000,
    name: '1W',
    align: (ts) => {
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      const day = d.getDay();
      d.setDate(d.getDate() - day); // Align to Sunday
      return d.getTime();
    },
    format: (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  },
  
  // Months
  {
    ms: 2592000000, // ~30 days
    name: '1M',
    align: (ts) => {
      const d = new Date(ts);
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    },
    format: (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  },
  
  // Years
  {
    ms: 31536000000, // 365 days
    name: '1Y',
    align: (ts) => {
      const d = new Date(ts);
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    },
    format: (ts) => new Date(ts).getFullYear().toString()
  }
];

/**
 * Picks the best time interval for current zoom level.
 */
function pickTimeInterval(
  timeMin: number,
  timeMax: number,
  pxWidth: number,
  config: HysteresisConfig,
  previousInterval: TimeInterval | null
): TimeInterval {
  const range = timeMax - timeMin;
  const msPerPx = range / pxWidth;
  
  // If previous interval is still valid, keep it (hysteresis)
  if (previousInterval) {
    const pxSpacing = previousInterval.ms / msPerPx;
    if (pxSpacing >= config.minPx && pxSpacing <= config.maxPx) {
      return previousInterval;
    }
  }
  
  // Find interval that produces spacing within target range
  const targetMs = config.targetPx * msPerPx;
  
  let best = TIME_INTERVALS[0];
  let bestDist = Infinity;
  
  for (const interval of TIME_INTERVALS) {
    const pxSpacing = interval.ms / msPerPx;
    
    // Must be within acceptable range
    if (pxSpacing >= config.minPx && pxSpacing <= config.maxPx) {
      const dist = Math.abs(pxSpacing - config.targetPx);
      if (dist < bestDist) {
        bestDist = dist;
        best = interval;
      }
    }
  }
  
  return best;
}

/**
 * Generates time ticks aligned to calendar boundaries.
 */
function generateTimeTicks(
  timeMin: number,
  timeMax: number,
  pxWidth: number,
  timeToPxFn: (t: number) => number,
  config: TickGeneratorConfig,
  state: { timeInterval: TimeInterval | null }
): Tick[] {
  const ticks: Tick[] = [];
  
  const interval = pickTimeInterval(
    timeMin, timeMax, pxWidth,
    { targetPx: config.targetMajorPx, minPx: config.minMajorPx, maxPx: config.maxMajorPx },
    state.timeInterval
  );
  state.timeInterval = interval;
  
  // Start at first aligned boundary >= timeMin
  let current = interval.align(timeMin);
  if (current < timeMin) {
    current = interval.align(timeMin + interval.ms);
  }
  
  while (current <= timeMax) {
    ticks.push({
      value: current,
      px: timeToPxFn(current),
      kind: 'major',
      label: interval.format(current)
    });
    
    current += interval.ms;
    
    // Re-align to handle DST and month boundaries
    current = interval.align(current + interval.ms * 0.5);
  }
  
  return ticks;
}
```

---

## 8. Minor Gridlines and Fade Logic

### Subdivision Rules

Based on the major step's "base digit":

| Major Step Base | Minor Divisions | Minor Step |
|-----------------|-----------------|------------|
| 1 × 10^k | 5 | 0.2 × 10^k |
| 2 × 10^k | 4 | 0.5 × 10^k |
| 5 × 10^k | 5 | 1 × 10^k |

### The Deep-Zoom Fade Effect

For a "premium" feel, minor lines should fade as they become dense, and then become major lines as you zoom in further:

```typescript
interface GridLineStyle {
  color: string;
  opacity: number;
  width: number;
}

/**
 * Calculates opacity for minor grid lines based on current spacing.
 * Creates smooth fade as zoom changes.
 */
function calculateMinorOpacity(
  minorPxSpacing: number,
  minVisible: number,    // e.g., 12
  fullOpacity: number,   // e.g., 40
  maxOpacity: number = 0.3
): number {
  if (minorPxSpacing < minVisible) return 0;
  if (minorPxSpacing >= fullOpacity) return maxOpacity;
  
  // Linear fade between minVisible and fullOpacity
  const t = (minorPxSpacing - minVisible) / (fullOpacity - minVisible);
  return t * maxOpacity;
}

/**
 * Gets appropriate style for a grid line.
 */
function getGridLineStyle(
  tick: Tick,
  majorPxSpacing: number,
  minorPxSpacing: number,
  config: {
    majorColor: string;
    majorOpacity: number;
    minorColor: string;
    lineWidth: number;
  }
): GridLineStyle {
  if (tick.kind === 'major' || tick.kind === 'edge') {
    return {
      color: config.majorColor,
      opacity: config.majorOpacity,
      width: config.lineWidth
    };
  }
  
  // Minor line with fade
  const opacity = calculateMinorOpacity(minorPxSpacing, 12, 40, config.majorOpacity * 0.5);
  
  return {
    color: config.minorColor,
    opacity,
    width: config.lineWidth
  };
}
```

---

## 9. Rendering Pipeline

### The Render Order

```
Frame Start
    │
    ├─► 1. Update viewport state (from pan/zoom input)
    │
    ├─► 2. Generate ticks (Y and X) ← This is cached if scale unchanged
    │
    ├─► 3. Clear canvas
    │
    ├─► 4. Draw background
    │
    ├─► 5. Draw grid (using tick positions)
    │       • Horizontal lines from Y ticks
    │       • Vertical lines from X ticks
    │
    ├─► 6. Draw chart data (candlesticks, lines)
    │       • Uses SAME transform as grid
    │
    ├─► 7. Draw overlays (crosshair, drawings)
    │
    ├─► 8. Draw axes (labels from SAME ticks as grid)
    │
    └─► Frame End
```

### Batched Grid Rendering

For performance, draw all grid lines in a single path:

```typescript
function renderGrid(
  ctx: CanvasRenderingContext2D,
  yTicks: Tick[],
  xTicks: Tick[],
  viewport: { width: number; height: number },
  config: {
    majorColor: string;
    majorOpacity: number;
    minorColor: string;
    minorOpacity: number;
    lineWidth: number;
  }
): void {
  // ─────────────────────────────────────────────────────────────────
  // Draw minor lines first (they go behind major)
  // ─────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = config.minorColor;
  ctx.globalAlpha = config.minorOpacity;
  ctx.lineWidth = config.lineWidth;
  
  for (const tick of yTicks) {
    if (tick.kind !== 'minor') continue;
    const y = Math.round(tick.px) + 0.5; // Pixel-perfect
    ctx.moveTo(0, y);
    ctx.lineTo(viewport.width, y);
  }
  
  for (const tick of xTicks) {
    if (tick.kind !== 'minor') continue;
    const x = Math.round(tick.px) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, viewport.height);
  }
  
  ctx.stroke();
  
  // ─────────────────────────────────────────────────────────────────
  // Draw major lines
  // ─────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = config.majorColor;
  ctx.globalAlpha = config.majorOpacity;
  
  for (const tick of yTicks) {
    if (tick.kind === 'minor') continue;
    const y = Math.round(tick.px) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(viewport.width, y);
  }
  
  for (const tick of xTicks) {
    if (tick.kind === 'minor') continue;
    const x = Math.round(tick.px) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, viewport.height);
  }
  
  ctx.stroke();
  
  // Reset alpha
  ctx.globalAlpha = 1;
}
```

---

## 10. Cross-Fade Transitions

### The Problem

When you zoom and the grid step changes (e.g., 100 → 200), the old lines disappear and new lines appear instantly. This looks "jarring."

### The Solution

When step changes:
1. Keep rendering old grid for ~100-150ms, fading out
2. Fade in new grid over the same period

```typescript
interface GridTransition {
  oldTicks: Tick[] | null;
  oldStartTime: number;
  duration: number;  // ms
}

class GridTransitionManager {
  private yTransition: GridTransition = { oldTicks: null, oldStartTime: 0, duration: 120 };
  private xTransition: GridTransition = { oldTicks: null, oldStartTime: 0, duration: 120 };
  
  /**
   * Called when Y ticks are regenerated.
   * If step changed, initiates a transition.
   */
  onYTicksChanged(prevTicks: Tick[], newTicks: Tick[], prevStep: number, newStep: number): void {
    if (prevStep !== newStep && prevTicks.length > 0) {
      this.yTransition.oldTicks = prevTicks;
      this.yTransition.oldStartTime = performance.now();
    }
  }
  
  /**
   * Gets the current fade progress (0 = start, 1 = complete).
   */
  getYTransitionProgress(): number {
    if (!this.yTransition.oldTicks) return 1;
    
    const elapsed = performance.now() - this.yTransition.oldStartTime;
    const progress = Math.min(1, elapsed / this.yTransition.duration);
    
    if (progress >= 1) {
      this.yTransition.oldTicks = null;
    }
    
    return progress;
  }
  
  /**
   * Renders grid with cross-fade if transition is active.
   */
  renderWithTransition(
    ctx: CanvasRenderingContext2D,
    currentYTicks: Tick[],
    xTicks: Tick[],
    viewport: { width: number; height: number },
    config: any
  ): void {
    const progress = this.getYTransitionProgress();
    
    if (progress < 1 && this.yTransition.oldTicks) {
      // Render old ticks fading out
      const fadeOutOpacity = config.majorOpacity * (1 - progress);
      renderGrid(ctx, this.yTransition.oldTicks, [], viewport, {
        ...config,
        majorOpacity: fadeOutOpacity,
        minorOpacity: fadeOutOpacity * 0.5
      });
      
      // Render new ticks fading in
      const fadeInOpacity = config.majorOpacity * progress;
      renderGrid(ctx, currentYTicks, xTicks, viewport, {
        ...config,
        majorOpacity: fadeInOpacity,
        minorOpacity: fadeInOpacity * 0.5
      });
    } else {
      // Normal render
      renderGrid(ctx, currentYTicks, xTicks, viewport, config);
    }
  }
}
```

---

## 11. Device Pixel Ratio Handling

### Why This Matters

On a 2x retina display, a "1px" CSS line is actually 2 device pixels. Without proper handling:
- Lines look blurry
- Grid and candlesticks can appear to "desync" during pan

### The Solution

```typescript
/**
 * Sets up canvas for crisp rendering on any DPR.
 */
function setupCanvasForDPR(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number
): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  
  // Set actual size in memory (scaled for DPR)
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  
  // Set display size (CSS)
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  
  const ctx = canvas.getContext('2d')!;
  
  // Scale all drawing operations by DPR
  ctx.scale(dpr, dpr);
  
  return ctx;
}

/**
 * Snaps a coordinate to the nearest device pixel for crisp lines.
 * 
 * For a 1px line to be crisp, it must be at a half-pixel offset
 * in CSS coordinates (which becomes a whole pixel in device coords).
 */
function snapToPixel(value: number, dpr: number = window.devicePixelRatio || 1): number {
  // Snap to device pixel boundary, then offset by half CSS pixel
  return Math.round(value * dpr) / dpr + 0.5 / dpr;
}
```

### Usage in Grid Rendering

```typescript
function renderGridLine(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  dpr: number
): void {
  // For horizontal lines, snap Y
  // For vertical lines, snap X
  if (y1 === y2) {
    // Horizontal
    const y = snapToPixel(y1, dpr);
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
  } else if (x1 === x2) {
    // Vertical
    const x = snapToPixel(x1, dpr);
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y2);
  } else {
    // Diagonal (rare for grid)
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
}
```

---

## 12. Complete TypeScript Implementation

### File Structure

```
src/
├── core/
│   ├── Scale.ts           # Transform functions
│   ├── NiceNumbers.ts     # Nice number algorithms
│   └── TickGenerator.ts   # Tick generation with hysteresis
├── grid/
│   ├── GridRenderer.ts    # Canvas rendering
│   ├── GridTransition.ts  # Cross-fade animations
│   └── GridConfig.ts      # Configuration types
├── axis/
│   ├── PriceAxis.ts       # Y-axis rendering
│   └── TimeAxis.ts        # X-axis rendering
└── Chart.ts               # Main integration
```

### Core Scale Class

```typescript
// src/core/Scale.ts

export interface ScaleState {
  dataMin: number;
  dataMax: number;
  pxMin: number;
  pxMax: number;
}

export class Scale {
  private state: ScaleState;
  private inverted: boolean;
  
  constructor(inverted: boolean = false) {
    this.inverted = inverted;
    this.state = { dataMin: 0, dataMax: 100, pxMin: 0, pxMax: 600 };
  }
  
  get dataRange(): number {
    return this.state.dataMax - this.state.dataMin;
  }
  
  get pxRange(): number {
    return this.state.pxMax - this.state.pxMin;
  }
  
  get pxPerUnit(): number {
    return this.pxRange / this.dataRange;
  }
  
  setDataRange(min: number, max: number): void {
    this.state.dataMin = min;
    this.state.dataMax = max;
  }
  
  setPxRange(min: number, max: number): void {
    this.state.pxMin = min;
    this.state.pxMax = max;
  }
  
  /**
   * Converts data value to pixel position.
   */
  dataToPx(value: number): number {
    const normalized = (value - this.state.dataMin) / this.dataRange;
    const clamped = this.inverted ? (1 - normalized) : normalized;
    return this.state.pxMin + clamped * this.pxRange;
  }
  
  /**
   * Converts pixel position to data value.
   */
  pxToData(px: number): number {
    let normalized = (px - this.state.pxMin) / this.pxRange;
    if (this.inverted) normalized = 1 - normalized;
    return this.state.dataMin + normalized * this.dataRange;
  }
  
  /**
   * Pans the scale by a pixel delta.
   */
  pan(deltaPx: number): void {
    const deltaData = deltaPx / this.pxPerUnit;
    const adjustment = this.inverted ? deltaData : -deltaData;
    this.state.dataMin += adjustment;
    this.state.dataMax += adjustment;
  }
  
  /**
   * Zooms the scale around a focal point.
   */
  zoom(factor: number, focalPx: number): void {
    const focalData = this.pxToData(focalPx);
    const newRange = this.dataRange / factor;
    
    // Position new range so focal point stays at same screen position
    const focalRatio = (focalData - this.state.dataMin) / this.dataRange;
    
    this.state.dataMin = focalData - focalRatio * newRange;
    this.state.dataMax = focalData + (1 - focalRatio) * newRange;
  }
  
  getState(): Readonly<ScaleState> {
    return { ...this.state };
  }
}
```

### Complete Tick Generator

```typescript
// src/core/TickGenerator.ts

import { niceStep, financialNiceStep, quantizeToTickSize } from './NiceNumbers';

export interface Tick {
  value: number;
  px: number;
  kind: 'major' | 'minor' | 'edge';
  label?: string;
}

export interface TickGenConfig {
  targetMajorPx: number;
  minMajorPx: number;
  maxMajorPx: number;
  showMinors: boolean;
  minMinorPx: number;
  tickSize: number;
  useFinancialNice: boolean;
  showEdgeTicks: boolean;
}

export const DEFAULT_TICK_CONFIG: TickGenConfig = {
  targetMajorPx: 80,
  minMajorPx: 50,
  maxMajorPx: 120,
  showMinors: true,
  minMinorPx: 12,
  tickSize: 0,
  useFinancialNice: true,
  showEdgeTicks: false
};

export class TickGenerator {
  private config: TickGenConfig;
  private cachedMajorStep: number | null = null;
  
  constructor(config: Partial<TickGenConfig> = {}) {
    this.config = { ...DEFAULT_TICK_CONFIG, ...config };
  }
  
  /**
   * Generates ticks for the given scale.
   */
  generate(
    dataMin: number,
    dataMax: number,
    pxSize: number,
    dataToPxFn: (v: number) => number,
    formatFn: (v: number, step: number) => string
  ): { ticks: Tick[]; majorStep: number } {
    const ticks: Tick[] = [];
    const range = Math.abs(dataMax - dataMin);
    const pxPerUnit = pxSize / range;
    
    // ── Pick major step with hysteresis ──────────────────────────
    const majorStep = this.pickStep(dataMin, dataMax, pxSize, pxPerUnit);
    this.cachedMajorStep = majorStep;
    
    const epsilon = majorStep * 1e-9;
    
    // ── Generate major ticks ─────────────────────────────────────
    const firstMajor = Math.ceil(Math.min(dataMin, dataMax) / majorStep) * majorStep;
    const lastData = Math.max(dataMin, dataMax);
    
    for (let v = firstMajor; v <= lastData + epsilon; v += majorStep) {
      const cleanV = Math.round(v / majorStep) * majorStep;
      ticks.push({
        value: cleanV,
        px: dataToPxFn(cleanV),
        kind: 'major',
        label: formatFn(cleanV, majorStep)
      });
    }
    
    // ── Generate minor ticks ─────────────────────────────────────
    if (this.config.showMinors) {
      const majorPxSpacing = majorStep * pxPerUnit;
      const base = majorStep / Math.pow(10, Math.floor(Math.log10(majorStep)));
      const minorCount = (Math.abs(base - 2) < 0.001) ? 4 : 5;
      const minorStep = majorStep / minorCount;
      const minorPxSpacing = minorStep * pxPerUnit;
      
      if (minorPxSpacing >= this.config.minMinorPx) {
        const firstMinor = Math.ceil(Math.min(dataMin, dataMax) / minorStep) * minorStep;
        
        for (let v = firstMinor; v <= lastData + epsilon; v += minorStep) {
          const cleanV = Math.round(v / minorStep) * minorStep;
          const isMajor = Math.abs((cleanV / majorStep) - Math.round(cleanV / majorStep)) < 1e-9;
          if (isMajor) continue;
          
          ticks.push({
            value: cleanV,
            px: dataToPxFn(cleanV),
            kind: 'minor'
          });
        }
      }
    }
    
    // ── Edge ticks ───────────────────────────────────────────────
    if (this.config.showEdgeTicks) {
      const threshold = majorStep * 0.2;
      const nearMin = ticks.some(t => t.kind === 'major' && Math.abs(t.value - dataMin) < threshold);
      const nearMax = ticks.some(t => t.kind === 'major' && Math.abs(t.value - dataMax) < threshold);
      
      if (!nearMin) {
        ticks.push({
          value: dataMin,
          px: dataToPxFn(dataMin),
          kind: 'edge',
          label: formatFn(dataMin, majorStep)
        });
      }
      if (!nearMax) {
        ticks.push({
          value: dataMax,
          px: dataToPxFn(dataMax),
          kind: 'edge',
          label: formatFn(dataMax, majorStep)
        });
      }
    }
    
    return { ticks, majorStep };
  }
  
  private pickStep(dataMin: number, dataMax: number, pxSize: number, pxPerUnit: number): number {
    const range = Math.abs(dataMax - dataMin);
    const cfg = this.config;
    
    // Hysteresis: keep current step if still valid
    if (this.cachedMajorStep !== null) {
      const curPx = this.cachedMajorStep * pxPerUnit;
      if (curPx >= cfg.minMajorPx && curPx <= cfg.maxMajorPx) {
        return this.cachedMajorStep;
      }
    }
    
    // Calculate new step
    const targetCount = Math.max(2, Math.round(pxSize / cfg.targetMajorPx));
    const rawStep = range / targetCount;
    
    let step = cfg.useFinancialNice
      ? financialNiceStep(rawStep)
      : niceStep(rawStep);
    
    step = quantizeToTickSize(step, cfg.tickSize);
    
    // Ensure within band
    for (let i = 0; i < 10; i++) {
      const px = step * pxPerUnit;
      if (px < cfg.minMajorPx) {
        step = quantizeToTickSize(step * 2, cfg.tickSize);
      } else if (px > cfg.maxMajorPx) {
        step = quantizeToTickSize(step / 2, cfg.tickSize);
      } else {
        break;
      }
    }
    
    return step;
  }
  
  /**
   * Resets hysteresis cache. Call when data changes significantly.
   */
  reset(): void {
    this.cachedMajorStep = null;
  }
}
```

### Grid Renderer

```typescript
// src/grid/GridRenderer.ts

import { Tick } from '../core/TickGenerator';

export interface GridStyle {
  majorColor: string;
  majorOpacity: number;
  minorColor: string;
  minorOpacity: number;
  lineWidth: number;
}

export const DEFAULT_GRID_STYLE: GridStyle = {
  majorColor: '#2B2F36',
  majorOpacity: 0.8,
  minorColor: '#2B2F36',
  minorOpacity: 0.3,
  lineWidth: 1
};

export class GridRenderer {
  private ctx: CanvasRenderingContext2D;
  private style: GridStyle;
  private dpr: number;
  
  constructor(ctx: CanvasRenderingContext2D, style: Partial<GridStyle> = {}) {
    this.ctx = ctx;
    this.style = { ...DEFAULT_GRID_STYLE, ...style };
    this.dpr = window.devicePixelRatio || 1;
  }
  
  /**
   * Renders the complete grid.
   */
  render(
    yTicks: Tick[],
    xTicks: Tick[],
    viewportWidth: number,
    viewportHeight: number
  ): void {
    const ctx = this.ctx;
    
    // ── Minor lines (behind major) ───────────────────────────────
    ctx.beginPath();
    ctx.strokeStyle = this.style.minorColor;
    ctx.globalAlpha = this.style.minorOpacity;
    ctx.lineWidth = this.style.lineWidth;
    
    for (const tick of yTicks) {
      if (tick.kind !== 'minor') continue;
      const y = this.snapY(tick.px);
      ctx.moveTo(0, y);
      ctx.lineTo(viewportWidth, y);
    }
    
    for (const tick of xTicks) {
      if (tick.kind !== 'minor') continue;
      const x = this.snapX(tick.px);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, viewportHeight);
    }
    
    ctx.stroke();
    
    // ── Major lines ──────────────────────────────────────────────
    ctx.beginPath();
    ctx.strokeStyle = this.style.majorColor;
    ctx.globalAlpha = this.style.majorOpacity;
    
    for (const tick of yTicks) {
      if (tick.kind === 'minor') continue;
      const y = this.snapY(tick.px);
      ctx.moveTo(0, y);
      ctx.lineTo(viewportWidth, y);
    }
    
    for (const tick of xTicks) {
      if (tick.kind === 'minor') continue;
      const x = this.snapX(tick.px);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, viewportHeight);
    }
    
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  
  /**
   * Snaps X coordinate for crisp vertical lines.
   */
  private snapX(x: number): number {
    return Math.round(x * this.dpr) / this.dpr + 0.5 / this.dpr;
  }
  
  /**
   * Snaps Y coordinate for crisp horizontal lines.
   */
  private snapY(y: number): number {
    return Math.round(y * this.dpr) / this.dpr + 0.5 / this.dpr;
  }
  
  setStyle(style: Partial<GridStyle>): void {
    this.style = { ...this.style, ...style };
  }
  
  setDPR(dpr: number): void {
    this.dpr = dpr;
  }
}
```

---

## 13. Integration Checklist

Before shipping, verify each item:

### Core Mechanics

- [ ] **Grid lines use same transform as data** - Pan test: zoom in, pan, verify grid and candles move identically
- [ ] **Nice numbers working** - Zoom test: grid should show 1, 2, 5, 10, 20, 50, 100... not 17, 34, 51
- [ ] **Hysteresis working** - Slow zoom test: grid step should not "flicker" between values
- [ ] **Axis labels match grid** - Every horizontal line touches a Y-axis label

### Time Scale

- [ ] **Calendar-aware intervals** - Day boundaries at midnight, month boundaries on 1st
- [ ] **Timezone correct** - Labels show exchange timezone, not UTC

### Visual Polish

- [ ] **Crisp lines** - Grid lines are 1px sharp, not blurry
- [ ] **DPR handled** - Test on retina display
- [ ] **Minor gridlines fade** - Zoom out: minors should gradually disappear
- [ ] **Cross-fade transitions** - When step changes, old grid fades out, new fades in

### Performance

- [ ] **60fps maintained** - Profile during rapid pan/zoom
- [ ] **No layout thrashing** - Canvas size set once per resize, not per frame
- [ ] **Tick generation cached** - Not recalculated every frame during pan

### Edge Cases

- [ ] **Zero/negative prices** - Grid handles -$5 to $5 range
- [ ] **Extreme zoom** - Grid at 0.0001 step and 10000 step both work
- [ ] **Single tick** - Grid works if only one line fits
- [ ] **No data** - Chart handles empty data gracefully

---

## Summary: The Three Requirements Solved

| Requirement | Solution |
|-------------|----------|
| **1. Grid adjusts on zoom** | Nice Numbers algorithm selects step. Hysteresis prevents jitter. |
| **2. Grid moves "glued" on pan** | Single transform (Scale) used by both grid and data. Pan changes offset, not scale. |
| **3. Grid aligns with axis** | Grid lines ARE axis ticks. Same array renders both. Alignment is guaranteed by construction. |

**The key insight:** Don't build a grid system. Build an axis tick system. The grid is just a rendering of those ticks.

---

*This document represents the optimal implementation based on analysis of TradingView's Lightweight Charts architecture, the Heckbert Nice Numbers algorithm, and established best practices in financial charting.*
