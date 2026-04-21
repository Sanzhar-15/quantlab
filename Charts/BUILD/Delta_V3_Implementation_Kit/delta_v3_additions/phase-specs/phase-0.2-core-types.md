# Phase 0.2: Core Types and Math

## Objective
Create foundational types and math utilities in `@anthropic/delta-chart-core`.

## File Structure
```
packages/core/src/
├── index.ts              # Re-exports everything
├── types/
│   ├── index.ts
│   ├── time.ts           # Time types
│   ├── geometry.ts       # Point, Rect, etc.
│   ├── series.ts         # Bar data types
│   ├── color.ts          # Color types
│   └── viewport.ts       # Viewport type
├── math/
│   ├── index.ts
│   ├── basic.ts          # clamp, lerp, etc.
│   ├── geometry.ts       # Rect operations
│   └── scale.ts          # Linear/log scales
├── format/
│   ├── index.ts
│   ├── price.ts          # Price formatting
│   ├── time.ts           # Time formatting
│   └── volume.ts         # Volume with K/M/B
└── __tests__/
    ├── math.test.ts
    ├── scale.test.ts
    └── format.test.ts
```

---

## Types

### types/time.ts
```typescript
/** Unix timestamp in seconds */
export type UTCTimestamp = number;

/** Business day representation */
export interface BusinessDay {
  year: number;
  month: number;  // 1-12
  day: number;    // 1-31
}

/** Union type for time values */
export type Time = UTCTimestamp | BusinessDay | string;

/** Type guards */
export function isUTCTimestamp(time: Time): time is UTCTimestamp {
  return typeof time === 'number';
}

export function isBusinessDay(time: Time): time is BusinessDay {
  return typeof time === 'object' && 'year' in time && 'month' in time && 'day' in time;
}

/** Convert any Time to UTCTimestamp */
export function toTimestamp(time: Time): UTCTimestamp {
  if (isUTCTimestamp(time)) return time;
  if (isBusinessDay(time)) {
    return Date.UTC(time.year, time.month - 1, time.day) / 1000;
  }
  return new Date(time).getTime() / 1000;
}
```

### types/geometry.ts
```typescript
export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
```

### types/series.ts
```typescript
import type { Time } from './time';

export interface BarData {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface LineData {
  time: Time;
  value: number;
}

export interface HistogramData {
  time: Time;
  value: number;
  color?: string;
}

/** GPU-friendly columnar format */
export interface SeriesBuffers {
  time: Float64Array;
  open: Float32Array;
  high: Float32Array;
  low: Float32Array;
  close: Float32Array;
  volume?: Float32Array;
}
```

### types/color.ts
```typescript
export type ColorType = string | GradientColor;

export interface GradientColor {
  type: 'linear' | 'radial';
  stops: Array<{ offset: number; color: string }>;
  angle?: number;
}

/** Parse hex/rgb to normalized RGBA */
export function parseColor(color: string): [number, number, number, number] {
  // Handle #RGB, #RRGGBB, #RRGGBBAA, rgb(), rgba()
  // Return [r, g, b, a] with values 0-1
}

/** Convert RGBA to u32 for GPU */
export function colorToU32(r: number, g: number, b: number, a: number): number {
  return (
    ((a * 255) << 24) |
    ((b * 255) << 16) |
    ((g * 255) << 8) |
    (r * 255)
  ) >>> 0;
}
```

### types/viewport.ts
```typescript
export interface Viewport {
  /** Visible time range (Unix timestamps) */
  timeStart: number;
  timeEnd: number;
  
  /** Visible price range */
  priceMin: number;
  priceMax: number;
  
  /** Canvas size in CSS pixels */
  width: number;
  height: number;
  
  /** Device pixel ratio */
  dpr: number;
}

export interface TimeRange {
  from: number;
  to: number;
}

export interface PriceRange {
  min: number;
  max: number;
}

export interface LogicalRange {
  from: number;  // Bar index
  to: number;
}
```

---

## Math Utilities

### math/basic.ts
```typescript
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, value: number): number {
  return (value - a) / (b - a);
}

export function remap(
  value: number,
  inMin: number, inMax: number,
  outMin: number, outMax: number
): number {
  const t = inverseLerp(inMin, inMax, value);
  return lerp(outMin, outMax, t);
}

export function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

export function normalize(x: number, y: number): [number, number] {
  const len = Math.sqrt(x * x + y * y);
  return len > 0 ? [x / len, y / len] : [0, 0];
}
```

### math/geometry.ts
```typescript
import type { Point, Rect } from '../types';

export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

export function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function expandRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

export function rectCenter(rect: Rect): Point {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}
```

### math/scale.ts
```typescript
export interface Scale {
  domain: [number, number];
  range: [number, number];
  
  /** Map domain value to range value */
  scale(value: number): number;
  
  /** Map range value back to domain value */
  invert(value: number): number;
  
  /** Create copy with new domain */
  setDomain(min: number, max: number): Scale;
  
  /** Create copy with new range */
  setRange(min: number, max: number): Scale;
}

export class LinearScale implements Scale {
  constructor(
    public domain: [number, number] = [0, 1],
    public range: [number, number] = [0, 1]
  ) {}
  
  scale(value: number): number {
    const t = (value - this.domain[0]) / (this.domain[1] - this.domain[0]);
    return this.range[0] + t * (this.range[1] - this.range[0]);
  }
  
  invert(value: number): number {
    const t = (value - this.range[0]) / (this.range[1] - this.range[0]);
    return this.domain[0] + t * (this.domain[1] - this.domain[0]);
  }
  
  setDomain(min: number, max: number): LinearScale {
    return new LinearScale([min, max], this.range);
  }
  
  setRange(min: number, max: number): LinearScale {
    return new LinearScale(this.domain, [min, max]);
  }
}

export class LogScale implements Scale {
  constructor(
    public domain: [number, number] = [1, 10],
    public range: [number, number] = [0, 1]
  ) {}
  
  scale(value: number): number {
    const logMin = Math.log10(this.domain[0]);
    const logMax = Math.log10(this.domain[1]);
    const t = (Math.log10(value) - logMin) / (logMax - logMin);
    return this.range[0] + t * (this.range[1] - this.range[0]);
  }
  
  invert(value: number): number {
    const logMin = Math.log10(this.domain[0]);
    const logMax = Math.log10(this.domain[1]);
    const t = (value - this.range[0]) / (this.range[1] - this.range[0]);
    return Math.pow(10, logMin + t * (logMax - logMin));
  }
  
  setDomain(min: number, max: number): LogScale {
    return new LogScale([min, max], this.range);
  }
  
  setRange(min: number, max: number): LogScale {
    return new LogScale(this.domain, [min, max]);
  }
}
```

---

## Formatting

### format/price.ts
```typescript
export interface PriceFormatOptions {
  precision?: number;
  minMove?: number;
  prefix?: string;
  suffix?: string;
}

export function formatPrice(
  price: number,
  options: PriceFormatOptions = {}
): string {
  const { precision = 2, prefix = '', suffix = '' } = options;
  const formatted = price.toFixed(precision);
  return `${prefix}${formatted}${suffix}`;
}

/** Auto-detect appropriate precision from price magnitude */
export function autoPrecion(price: number): number {
  if (price >= 1000) return 0;
  if (price >= 100) return 1;
  if (price >= 1) return 2;
  if (price >= 0.01) return 4;
  return 8;
}
```

### format/volume.ts
```typescript
export function formatVolume(volume: number): string {
  if (volume >= 1_000_000_000) {
    return (volume / 1_000_000_000).toFixed(2) + 'B';
  }
  if (volume >= 1_000_000) {
    return (volume / 1_000_000).toFixed(2) + 'M';
  }
  if (volume >= 1_000) {
    return (volume / 1_000).toFixed(2) + 'K';
  }
  return volume.toFixed(0);
}
```

### format/time.ts
```typescript
export type TimeFormat = 
  | 'time'      // HH:MM
  | 'datetime'  // MMM DD HH:MM
  | 'date'      // MMM DD
  | 'month'     // MMM YYYY
  | 'year';     // YYYY

export function formatTime(
  timestamp: number,
  format: TimeFormat = 'datetime'
): string {
  const date = new Date(timestamp * 1000);
  
  switch (format) {
    case 'time':
      return date.toLocaleTimeString(undefined, { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
    case 'datetime':
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    case 'date':
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
    case 'month':
      return date.toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric',
      });
    case 'year':
      return date.getFullYear().toString();
  }
}
```

---

## Tests

### __tests__/math.test.ts
```typescript
import { describe, it, expect } from 'vitest';
import { clamp, lerp, inverseLerp, distance } from '../math/basic';
import { pointInRect, rectsIntersect } from '../math/geometry';

describe('basic math', () => {
  it('clamps values correctly', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
  
  it('lerp interpolates correctly', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });
  
  it('inverseLerp inverts correctly', () => {
    expect(inverseLerp(0, 10, 0)).toBe(0);
    expect(inverseLerp(0, 10, 10)).toBe(1);
    expect(inverseLerp(0, 10, 5)).toBe(0.5);
  });
});

describe('geometry', () => {
  it('pointInRect works correctly', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    expect(pointInRect({ x: 50, y: 50 }, rect)).toBe(true);
    expect(pointInRect({ x: 150, y: 50 }, rect)).toBe(false);
  });
});
```

### __tests__/scale.test.ts
```typescript
import { describe, it, expect } from 'vitest';
import { LinearScale, LogScale } from '../math/scale';

describe('LinearScale', () => {
  it('scales values correctly', () => {
    const scale = new LinearScale([0, 100], [0, 1]);
    expect(scale.scale(0)).toBe(0);
    expect(scale.scale(50)).toBe(0.5);
    expect(scale.scale(100)).toBe(1);
  });
  
  it('inverts correctly', () => {
    const scale = new LinearScale([0, 100], [0, 1]);
    expect(scale.invert(0)).toBe(0);
    expect(scale.invert(0.5)).toBe(50);
    expect(scale.invert(1)).toBe(100);
  });
  
  it('scale then invert returns original', () => {
    const scale = new LinearScale([50, 200], [100, 800]);
    const original = 125;
    const scaled = scale.scale(original);
    const inverted = scale.invert(scaled);
    expect(inverted).toBeCloseTo(original);
  });
});
```

---

## Definition of Done
- [ ] All types export from `@anthropic/delta-chart-core`
- [ ] All math functions have unit tests
- [ ] Scale inversion tests pass (forward then backward = identity)
- [ ] `pnpm test` passes
- [ ] TypeScript compiles with strict mode
