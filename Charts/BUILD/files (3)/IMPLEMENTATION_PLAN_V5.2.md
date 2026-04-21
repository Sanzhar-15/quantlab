# Delta Charting V5.2: Implementation Plan

## Overview

**Goal:** Functional trading chart in 2 weeks
**Approach:** Build the minimum that achieves excellence, defer everything else

---

## Day-by-Day Plan

### Day 1: Foundation

**Morning: Scaffolding**
```
delta-chart/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── index.ts
│   └── types.ts
└── demo/
    ├── index.html
    └── main.ts
```

**Afternoon: Types + PerfHarness**

```typescript
// src/types.ts
export type UTCTimestamp = number & { __brand: 'UTCTimestamp' };

export interface Bar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Theme {
  background: string;
  grid: string;
  text: string;
  bullish: string;
  bearish: string;
  crosshair: string;
}

export const DARK_THEME: Theme = {
  background: '#131722',
  grid: '#2A2E39',
  text: '#D1D4DC',
  bullish: '#26A69A',
  bearish: '#EF5350',
  crosshair: '#9598A1',
};
```

```typescript
// src/perf/harness.ts
export class PerfHarness {
  generateBars(count: number): Bar[] { /* ... */ }
  async benchmark(fn: () => void): Promise<Stats> { /* ... */ }
}
```

**Definition of Done:**
- [ ] `npm run dev` shows blank page
- [ ] Can generate 100k bars
- [ ] Can measure render time

---

### Day 2: Rendering Foundation

**Morning: Layer Compositor**

```typescript
// src/rendering/layers.ts
export class LayerCompositor {
  private layers: Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>;
  
  constructor(container: HTMLElement) {
    this.createLayer('background', 0);
    this.createLayer('data', 1);
    this.createLayer('interaction', 2);
    this.setupHiDPI();
  }
  
  private setupHiDPI() {
    // devicePixelContentBox implementation
  }
}
```

**Afternoon: Render Loop**

```typescript
// src/rendering/loop.ts
export class RenderLoop {
  private running = false;
  private frameCallback: (dt: number) => void;
  
  start() { /* RAF loop */ }
  stop() { /* cancel RAF */ }
}
```

**Definition of Done:**
- [ ] 3 canvases created and sized correctly
- [ ] HiDPI working (text looks sharp)
- [ ] Render loop running at 60fps

---

### Day 3: Viewport + Candlesticks

**Morning: Viewport Math**

```typescript
// src/math/viewport.ts
export class Viewport {
  timeToX(time: UTCTimestamp): number { /* ... */ }
  xToTime(x: number): UTCTimestamp { /* ... */ }
  priceToY(price: number): number { /* ... */ }
  yToPrice(y: number): number { /* ... */ }
  pan(dx: number): void { /* ... */ }
  zoom(factor: number, centerX: number): void { /* ... */ }
}
```

**Afternoon: Candlestick Renderer**

```typescript
// src/rendering/candlesticks.ts
export class CandlestickRenderer {
  render(ctx: CanvasRenderingContext2D, bars: Bar[], viewport: Viewport): void {
    const upPath = new Path2D();
    const downPath = new Path2D();
    // ... batch all candles into paths
    ctx.fill(upPath);
    ctx.fill(downPath);
  }
}
```

**Definition of Done:**
- [ ] Candles render correctly
- [ ] Colors correct (green up, red down)
- [ ] Coordinate transforms work

---

### Day 4: Grid + Axes

**Morning: Grid Renderer**

```typescript
// src/rendering/grid.ts
export class GridRenderer {
  render(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    // Price lines (horizontal)
    // Time lines (vertical)
    // Crisp 1px lines via coordinate snapping
  }
}
```

**Afternoon: Price Axis + Time Axis**

```typescript
// src/rendering/axes.ts
export class PriceAxis {
  render(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    // Price labels on right side
  }
}

export class TimeAxis {
  render(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    // Time labels on bottom
  }
}
```

**Definition of Done:**
- [ ] Grid lines are crisp (not blurry)
- [ ] Price axis shows correct values
- [ ] Time axis shows appropriate intervals

---

### Day 5: CHECKPOINT 1

**Run performance harness:**

```typescript
const harness = new PerfHarness();
const bars10k = harness.generateBars(10000);

const stats = await harness.benchmark(() => {
  candlestickRenderer.render(ctx, bars10k, viewport);
});

console.log('10k candles:', stats);
// Target: P95 < 10ms
```

**Checklist:**
- [ ] 10k candles renders in < 10ms P95
- [ ] Grid lines are pixel-perfect
- [ ] Static chart looks professional

**If failed:** Debug and fix before proceeding. Do not continue with broken foundation.

---

### Day 6: Interaction Foundation

**Morning: Velocity Tracker**

```typescript
// src/interaction/velocity.ts
export class VelocityTracker {
  addSample(x: number, y: number, t: number): void { /* ... */ }
  getVelocity(): { vx: number; vy: number } { /* ... */ }
  reset(): void { /* ... */ }
}
```

**Afternoon: Interaction Controller**

```typescript
// src/interaction/controller.ts
export class InteractionController {
  private state: 'idle' | 'dragging' | 'momentum' = 'idle';
  
  onPointerDown(x: number, y: number): void { /* ... */ }
  onPointerMove(x: number, y: number): { dx: number } | null { /* ... */ }
  onPointerUp(): void { /* ... */ }
  step(dt: number): { dx: number } { /* ... */ }
}
```

**Definition of Done:**
- [ ] Can detect drag start
- [ ] Velocity tracking works
- [ ] State transitions correctly

---

### Day 7: Momentum + Pan

**Morning: Momentum Controller**

```typescript
// src/interaction/momentum.ts
export class MomentumController {
  start(vx: number): void { /* ... */ }
  step(dt: number): { dx: number; active: boolean } { /* ... */ }
  stop(): void { /* ... */ }
}
```

**Afternoon: Integration with Viewport**

Wire up:
1. PointerDown → stop momentum, start tracking
2. PointerMove → direct pan (1:1)
3. PointerUp → start momentum with release velocity
4. Each frame → step momentum, apply to viewport

**Definition of Done:**
- [ ] Direct manipulation feels instant (no lag)
- [ ] Momentum feels smooth (iOS-like)
- [ ] Can interrupt momentum by touching

---

### Day 8: Crosshair + Indicators

**Morning: Crosshair**

```typescript
// src/interaction/crosshair.ts
export class Crosshair {
  update(x: number, y: number): void {
    this.x = x;  // DIRECT, no smoothing
    this.y = y;
  }
  
  render(ctx: CanvasRenderingContext2D): void {
    // Dashed crosshair lines
    // Price/time labels
  }
}
```

**Afternoon: Basic Indicators**

```typescript
// src/indicators/sma.ts
export function calculateSMA(bars: Bar[], period: number): number[] { /* ... */ }

// src/indicators/ema.ts  
export function calculateEMA(bars: Bar[], period: number): number[] { /* ... */ }

// src/rendering/indicator.ts
export class IndicatorRenderer {
  render(ctx: CanvasRenderingContext2D, values: number[], viewport: Viewport, color: string): void {
    // Draw line chart overlay
  }
}
```

**Definition of Done:**
- [ ] Crosshair follows mouse instantly
- [ ] Price/time display accurate
- [ ] SMA/EMA render correctly over candles

---

### Day 9: Real-Time + Volume

**Morning: Real-Time Updates**

```typescript
// src/data/manager.ts
export class DataManager {
  private bars: Bar[] = [];
  
  setData(bars: Bar[]): void { /* ... */ }
  appendBar(bar: Bar): void { /* ... */ }
  updateLastBar(bar: Bar): void { /* ... */ }
  getVisibleBars(viewport: Viewport): Bar[] { /* ... */ }
}
```

**Afternoon: Volume Histogram**

```typescript
// src/rendering/volume.ts
export class VolumeRenderer {
  render(ctx: CanvasRenderingContext2D, bars: Bar[], viewport: Viewport): void {
    // Volume bars at bottom
  }
}
```

**Definition of Done:**
- [ ] New bars append without jank
- [ ] Last bar updates smoothly
- [ ] Volume histogram renders correctly

---

### Day 10: CHECKPOINT 2 + Demo

**Morning: Full Integration Test**

```typescript
// Run interaction benchmark
const stats = await harness.benchmarkInteraction(chart, 5000);
console.log('Frame times during pan:', stats);
// Target: P95 < 16.67ms, dropped frames < 1%
```

**Afternoon: Demo Page**

```html
<!-- demo/index.html -->
<div id="chart" style="width: 100%; height: 600px;"></div>
<script type="module">
  import { DeltaChart } from '../src';
  
  const chart = new DeltaChart(document.getElementById('chart'));
  chart.setData(generateSampleData());
  chart.addIndicator('sma', { period: 20, color: '#2196F3' });
</script>
```

**Final Checklist:**
- [ ] 10k candles < 10ms render
- [ ] 60fps during pan (P95 < 16.67ms)
- [ ] < 1% dropped frames
- [ ] Direct manipulation has no lag
- [ ] Momentum feels iOS-like
- [ ] Crosshair is instant
- [ ] Indicators render correctly
- [ ] Real-time updates don't jank

---

## File Structure (Final)

```
src/
├── types.ts                 # Type definitions
├── index.ts                 # Public API
├── math/
│   ├── viewport.ts          # Coordinate transforms
│   └── scale.ts             # Tick generation
├── rendering/
│   ├── layers.ts            # Layer compositor
│   ├── loop.ts              # Render loop
│   ├── candlesticks.ts      # Candlestick renderer
│   ├── grid.ts              # Grid renderer
│   ├── axes.ts              # Price/Time axes
│   ├── volume.ts            # Volume histogram
│   └── indicator.ts         # Indicator lines
├── interaction/
│   ├── controller.ts        # Main interaction handler
│   ├── velocity.ts          # Velocity tracking
│   ├── momentum.ts          # Momentum physics
│   └── crosshair.ts         # Crosshair
├── indicators/
│   ├── sma.ts               # Simple Moving Average
│   └── ema.ts               # Exponential Moving Average
├── data/
│   └── manager.ts           # Data management
└── perf/
    └── harness.ts           # Performance measurement
```

**Total files:** 17
**Estimated lines of code:** ~1500

---

## Cursor Session Strategy

### Session 1 (Day 1)
```
"Create the project scaffolding for a TypeScript/Vite charting library.
Then implement the type definitions and performance harness.
[Paste types.ts and harness.ts specs]"
```

### Session 2 (Day 2)
```
"Implement the 3-layer canvas compositor with HiDPI support using devicePixelContentBox.
Then implement the render loop.
[Paste layers.ts and loop.ts specs]"
```

### Session 3 (Day 3)
```
"Implement the Viewport class for coordinate transformations.
Then implement the CandlestickRenderer with Path2D batching.
[Paste viewport.ts and candlesticks.ts specs]"
```

*Continue pattern for remaining days...*

---

## Success Metrics

### Performance
| Metric | Target | Measurement |
|--------|--------|-------------|
| 10k candles render | < 10ms P95 | PerfHarness |
| Frame time during pan | < 16.67ms P95 | PerfHarness |
| Dropped frames | < 1% | Frame count |

### Quality
| Metric | Target | Measurement |
|--------|--------|-------------|
| HiDPI sharpness | No blur at 2x | Visual inspection |
| Grid crispness | 1px lines exact | Visual inspection |
| Momentum feel | iOS-like | User testing |

### Functionality
| Feature | Required | Verification |
|---------|----------|--------------|
| Pan | Direct 1:1 | Manual test |
| Zoom | Works correctly | Manual test |
| Momentum | Smooth decay | Manual test |
| Crosshair | Instant response | Manual test |
| SMA indicator | Correct values | Calculated check |
| Real-time updates | No jank | Manual test |

---

*This plan is executable. Each day has clear goals and definitions of done. Checkpoints prevent wasted effort on a broken foundation.*
