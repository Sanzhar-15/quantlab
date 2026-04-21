# Delta Charting Engine V5.2: Final Specification

## Executive Summary

**Mission:** Build a charting engine that demonstrably exceeds TradingView in specific, measurable ways.

**Scope:** V1 delivers a production-ready chart with core functionality. V2 adds polish and advanced features.

**Timeline:** 2 weeks to V1 demo, 3 weeks to production-ready.

**Key Differentiators (concrete, not vague):**

| Differentiator | TradingView | Delta | How We Prove It |
|----------------|-------------|-------|-----------------|
| HiDPI sharpness | devicePixelRatio | **devicePixelContentBox** | Side-by-side screenshot comparison |
| Momentum feel | Basic deceleration | **iOS-like friction curve** | User preference test |
| Touch response | Acceptable | **<16ms processing** | Instrumented measurement |
| Real-time jank | Occasional | **<1% dropped frames** | Frame time histogram |

---

## Part 1: What We're Building (And NOT Building)

### V1 Scope (2 weeks)

**IN:**
- Candlestick/OHLC rendering with Path2D batching
- HiDPI rendering (devicePixelContentBox)
- 3-layer architecture (static, data, interaction)
- Direct manipulation (1:1 during drag)
- Friction-based momentum (iOS-like)
- Crosshair with price/time display
- Price axis with auto-scaling
- Time axis with intelligent intervals
- Basic indicators: SMA, EMA overlays
- Volume histogram
- Real-time bar updates without jank
- Performance harness

**OUT (deferred to V2):**
- Analytic spring solver (Euler is sufficient for 60Hz)
- Rubber-band overscroll (stop at boundaries instead)
- Drawing tools
- Complex indicators (RSI, MACD, Bollinger)
- Multi-chart synchronization
- Order placement from chart

### Why This Scope?

Every item in V1 is **essential for a functional trading chart**. Everything in V2 is **polish or advanced features**.

---

## Part 2: Architecture

### 2.1 Three-Layer Model

After analysis, **3 layers is optimal** for V1:

```
┌─────────────────────────────────────────┐
│  Layer 3: INTERACTION (frame)           │  Crosshair, tooltips
├─────────────────────────────────────────┤
│  Layer 2: DATA (viewport/data)          │  Grid, candles, indicators
├─────────────────────────────────────────┤
│  Layer 1: BACKGROUND (static)           │  Background color
└─────────────────────────────────────────┘
```

**Rationale:** 
- Grid and data almost always update together (on pan/zoom)
- Separating them saves ~0.5ms in rare cases (new bar without pan)
- That 0.5ms isn't worth the extra compositor overhead
- **Profile after V1 — add 4th layer only if data proves it's needed**

```typescript
const LAYERS = [
  { id: 'background', zIndex: 0, updateOn: 'theme-change' },
  { id: 'data', zIndex: 1, updateOn: 'viewport-or-data' },
  { id: 'interaction', zIndex: 2, updateOn: 'frame' },
];
```

### 2.2 Render Loop

```typescript
class RenderLoop {
  private running = false;
  private lastTime = 0;
  
  tick = (now: number) => {
    if (!this.running) return;
    
    const dt = Math.min(now - this.lastTime, 32); // Cap at 32ms
    this.lastTime = now;
    
    // 1. Process pending input
    const input = this.inputQueue.flush();
    
    // 2. Update physics (momentum if active)
    const motion = this.physics.step(dt);
    
    // 3. Update viewport
    if (motion.dx !== 0) {
      this.viewport.pan(motion.dx, 0);
      this.markDirty('data');
    }
    
    // 4. Render dirty layers
    this.renderDirtyLayers();
    
    // 5. Record metrics
    this.metrics.recordFrame(performance.now() - now);
    
    requestAnimationFrame(this.tick);
  };
}
```

---

## Part 3: Physics System (Simplified)

### 3.1 Design Philosophy

**V5.1 was over-engineered.** V5.2 uses the simplest approach that achieves the feel we want.

### 3.2 Velocity Tracker (Keep)

Essential for computing release velocity. Same as V5.1.

```typescript
class VelocityTracker {
  private samples: Array<{ x: number; y: number; t: number }> = [];
  
  addSample(x: number, y: number, t: number): void { /* ... */ }
  getVelocity(): { vx: number; vy: number } { /* weighted average */ }
  reset(): void { this.samples = []; }
}
```

### 3.3 Momentum Controller (Simplified)

**Friction-based, NOT spring-based.** Simple Euler integration with dt clamping.

```typescript
class MomentumController {
  private vx = 0;
  private vy = 0;
  
  // iOS scroll uses ~0.998 decay per frame at 60fps
  // That's 0.998^60 ≈ 0.89 per second, or about 11% velocity remaining after 1s
  private readonly FRICTION = 0.95; // Slightly more friction than iOS
  private readonly MIN_VELOCITY = 0.5;
  
  start(vx: number, vy: number): void {
    this.vx = vx;
    this.vy = vy;
  }
  
  step(dtMs: number): { dx: number; dy: number; active: boolean } {
    if (Math.hypot(this.vx, this.vy) < this.MIN_VELOCITY) {
      return { dx: 0, dy: 0, active: false };
    }
    
    // Simple Euler integration
    const dtSec = dtMs / 1000;
    const dx = this.vx * dtSec;
    const dy = this.vy * dtSec;
    
    // Apply friction (frame-rate independent via dt)
    const frictionPerFrame = Math.pow(this.FRICTION, dtMs / 16.67);
    this.vx *= frictionPerFrame;
    this.vy *= frictionPerFrame;
    
    return { dx, dy, active: true };
  }
  
  stop(): void {
    this.vx = this.vy = 0;
  }
}
```

### 3.4 No Spring, No Rubber-Band in V1

**Boundaries:** Just stop. Don't spring back, don't rubber-band.

```typescript
// In viewport.pan():
pan(dx: number, dy: number): void {
  const newStart = this.startTime - this.pixelsToTime(dx);
  const newEnd = this.endTime - this.pixelsToTime(dx);
  
  // Clamp to data bounds
  if (newStart < this.dataStart) {
    // Just stop, don't rubber-band
    return;
  }
  if (newEnd > this.dataEnd) {
    return;
  }
  
  this.startTime = newStart;
  this.endTime = newEnd;
}
```

**Why no rubber-band?** It's polish. Pro traders care about precision, not bounce effects. Add in V2 if users request it.

---

## Part 4: Interaction Model

### 4.1 State Machine (Simplified)

Three states, not five:

```typescript
type InteractionState = 'idle' | 'dragging' | 'momentum';

class InteractionController {
  private state: InteractionState = 'idle';
  private velocityTracker = new VelocityTracker();
  private momentum = new MomentumController();
  private lastPointer = { x: 0, y: 0 };
  
  onPointerDown(x: number, y: number): void {
    this.momentum.stop(); // Stop any ongoing momentum
    this.velocityTracker.reset();
    this.velocityTracker.addSample(x, y, performance.now());
    this.lastPointer = { x, y };
    this.state = 'idle'; // Wait for movement to confirm drag
  }
  
  onPointerMove(x: number, y: number): { dx: number; dy: number } | null {
    const now = performance.now();
    this.velocityTracker.addSample(x, y, now);
    
    const dx = x - this.lastPointer.x;
    const dy = y - this.lastPointer.y;
    this.lastPointer = { x, y };
    
    // Confirm drag after small movement threshold
    if (this.state === 'idle' && Math.hypot(dx, dy) > 3) {
      this.state = 'dragging';
    }
    
    if (this.state === 'dragging') {
      // DIRECT 1:1 — the most important rule
      return { dx, dy };
    }
    
    return null;
  }
  
  onPointerUp(): void {
    if (this.state === 'dragging') {
      const { vx, vy } = this.velocityTracker.getVelocity();
      
      if (Math.abs(vx) > 100) { // Minimum velocity for momentum
        this.momentum.start(vx, vy);
        this.state = 'momentum';
      } else {
        this.state = 'idle';
      }
    } else {
      this.state = 'idle';
    }
  }
  
  step(dtMs: number): { dx: number; dy: number } {
    if (this.state === 'momentum') {
      const result = this.momentum.step(dtMs);
      if (!result.active) {
        this.state = 'idle';
      }
      return { dx: result.dx, dy: result.dy };
    }
    return { dx: 0, dy: 0 };
  }
}
```

### 4.2 Crosshair (Direct, No Spring)

```typescript
class Crosshair {
  private x = 0;
  private y = 0;
  private visible = false;
  
  update(mouseX: number, mouseY: number, inChartArea: boolean): void {
    this.x = mouseX;  // DIRECT — no spring, no smoothing
    this.y = mouseY;
    this.visible = inChartArea;
  }
  
  render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.visible) return;
    
    ctx.strokeStyle = '#9598A1';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    
    // Crisp lines via coordinate snapping
    const x = Math.round(this.x) + 0.5;
    const y = Math.round(this.y) + 0.5;
    
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    
    ctx.setLineDash([]);
  }
}
```

---

## Part 5: Rendering

### 5.1 HiDPI Setup (devicePixelContentBox)

This is our primary technical differentiator.

```typescript
function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', {
    alpha: false,        // Opaque = faster
    desynchronized: true // Lower latency
  })!;
  
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    
    // devicePixelContentBox gives EXACT physical pixels
    const dpcb = entry.devicePixelContentBoxSize?.[0];
    
    if (dpcb) {
      canvas.width = dpcb.inlineSize;
      canvas.height = dpcb.blockSize;
    } else {
      // Fallback
      const dpr = devicePixelRatio;
      canvas.width = Math.round(entry.contentRect.width * dpr);
      canvas.height = Math.round(entry.contentRect.height * dpr);
    }
    
    // Scale context to CSS pixels
    const cssWidth = entry.contentRect.width;
    const cssHeight = entry.contentRect.height;
    ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / cssHeight, 0, 0);
  });
  
  observer.observe(canvas, { box: 'device-pixel-content-box' });
  
  return ctx;
}
```

### 5.2 Candlestick Rendering (Path2D Batching)

```typescript
class CandlestickRenderer {
  render(ctx: CanvasRenderingContext2D, bars: Bar[], viewport: Viewport, theme: Theme): void {
    if (bars.length === 0) return;
    
    const upPath = new Path2D();
    const downPath = new Path2D();
    
    const barWidth = Math.max(1, viewport.getPixelsPerBar() * 0.8);
    const wickWidth = Math.max(1, barWidth * 0.15);
    
    for (const bar of bars) {
      const x = viewport.timeToX(bar.time);
      const isUp = bar.close >= bar.open;
      const path = isUp ? upPath : downPath;
      
      // Body (pixel-snapped)
      const bodyTop = Math.round(viewport.priceToY(Math.max(bar.open, bar.close)));
      const bodyBottom = Math.round(viewport.priceToY(Math.min(bar.open, bar.close)));
      const bodyHeight = Math.max(1, bodyBottom - bodyTop);
      path.rect(Math.round(x - barWidth/2), bodyTop, Math.round(barWidth), bodyHeight);
      
      // Wick
      const wickTop = Math.round(viewport.priceToY(bar.high));
      const wickBottom = Math.round(viewport.priceToY(bar.low));
      path.rect(Math.round(x - wickWidth/2), wickTop, Math.round(wickWidth), wickBottom - wickTop);
    }
    
    // Two fill calls total
    ctx.fillStyle = theme.bullish;
    ctx.fill(upPath);
    ctx.fillStyle = theme.bearish;
    ctx.fill(downPath);
  }
}
```

### 5.3 Grid Rendering

```typescript
class GridRenderer {
  render(ctx: CanvasRenderingContext2D, viewport: Viewport, width: number, height: number): void {
    ctx.strokeStyle = '#2A2E39';
    ctx.lineWidth = 1;
    ctx.beginPath();
    
    // Horizontal lines (price)
    const priceTicks = this.calculatePriceTicks(viewport);
    for (const price of priceTicks) {
      const y = Math.round(viewport.priceToY(price)) + 0.5; // Crisp
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    
    // Vertical lines (time)
    const timeTicks = this.calculateTimeTicks(viewport);
    for (const time of timeTicks) {
      const x = Math.round(viewport.timeToX(time)) + 0.5; // Crisp
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    
    ctx.stroke();
  }
}
```

### 5.4 Basic Indicators (SMA/EMA)

```typescript
interface Indicator {
  name: string;
  calculate(bars: Bar[]): number[];
  render(ctx: CanvasRenderingContext2D, values: number[], viewport: Viewport): void;
}

class SMAIndicator implements Indicator {
  constructor(private period: number, private color: string) {}
  
  name = `SMA(${this.period})`;
  
  calculate(bars: Bar[]): number[] {
    const result: number[] = new Array(bars.length).fill(NaN);
    let sum = 0;
    
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= this.period) {
        sum -= bars[i - this.period].close;
      }
      if (i >= this.period - 1) {
        result[i] = sum / this.period;
      }
    }
    
    return result;
  }
  
  render(ctx: CanvasRenderingContext2D, values: number[], viewport: Viewport): void {
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    
    let started = false;
    for (let i = 0; i < values.length; i++) {
      if (isNaN(values[i])) continue;
      
      const x = viewport.indexToX(i);
      const y = viewport.priceToY(values[i]);
      
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    
    ctx.stroke();
  }
}

class EMAIndicator implements Indicator {
  constructor(private period: number, private color: string) {}
  
  name = `EMA(${this.period})`;
  
  calculate(bars: Bar[]): number[] {
    const result: number[] = new Array(bars.length).fill(NaN);
    const multiplier = 2 / (this.period + 1);
    
    // First EMA is SMA
    let sum = 0;
    for (let i = 0; i < this.period && i < bars.length; i++) {
      sum += bars[i].close;
    }
    
    if (bars.length >= this.period) {
      result[this.period - 1] = sum / this.period;
      
      for (let i = this.period; i < bars.length; i++) {
        result[i] = (bars[i].close - result[i-1]) * multiplier + result[i-1];
      }
    }
    
    return result;
  }
  
  render = SMAIndicator.prototype.render; // Same rendering logic
}
```

---

## Part 6: Performance Harness

### 6.1 Implementation

```typescript
class PerfHarness {
  generateBars(count: number): Bar[] {
    const bars: Bar[] = [];
    let price = 100, time = Date.now() - count * 60000;
    
    for (let i = 0; i < count; i++) {
      const change = (Math.random() - 0.5) * 2;
      bars.push({
        time: time as UTCTimestamp,
        open: price,
        high: price + Math.random(),
        low: price - Math.random(),
        close: price + change,
        volume: Math.random() * 1e6,
      });
      price += change;
      time += 60000;
    }
    return bars;
  }
  
  async benchmark(renderFn: () => void, iterations = 100): Promise<Stats> {
    // Warm up
    for (let i = 0; i < 10; i++) renderFn();
    
    // Measure
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      renderFn();
      times.push(performance.now() - start);
    }
    
    return this.computeStats(times);
  }
  
  private computeStats(times: number[]): Stats {
    const sorted = [...times].sort((a, b) => a - b);
    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sorted.reduce((a, b) => a + b) / sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }
}
```

### 6.2 Success Criteria

| Metric | Target | Blocker if missed? |
|--------|--------|-------------------|
| 10k candles render | <10ms P95 | Yes |
| Frame time during pan | <16.67ms P95 | Yes |
| Dropped frames | <1% | Yes |
| Input processing | <2ms P95 | No (nice to have) |

---

## Part 7: Implementation Plan

### Week 1: Core

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Scaffolding + Types + PerfHarness | Can measure render time |
| 2 | Layer Compositor + Render Loop | Canvas structure works |
| 3 | Viewport + Candlestick Renderer | Candles visible |
| 4 | Grid + Axes | Full static chart |
| 5 | **CHECKPOINT**: 10k candles < 10ms? | Validated performance |

### Week 2: Interaction + Polish

| Day | Task | Deliverable |
|-----|------|-------------|
| 6 | Interaction Controller + Direct Manipulation | Pan works |
| 7 | Momentum + Crosshair | Release momentum works |
| 8 | Basic Indicators (SMA, EMA) | Overlays work |
| 9 | Real-time Updates + Volume | Live data works |
| 10 | **CHECKPOINT**: 60fps during interaction? + Demo | V1 Complete |

### Week 3 (Optional): Polish

| Day | Task |
|-----|------|
| 11-12 | Bug fixes, edge cases |
| 13-14 | Documentation, cleanup |
| 15 | V1 Release |

---

## Part 8: V2 Roadmap (Post-V1)

**If users request:**
- Analytic spring solver (for 120Hz displays)
- Rubber-band overscroll
- More indicators (RSI, MACD, Bollinger)
- Drawing tools (trendlines, Fibonacci)
- Multi-chart sync

**If metrics show need:**
- 4th layer (if grid/data separation proves beneficial)
- Worker offloading (if indicator calculation blocks rendering)
- LOD pyramid (if 100k+ bars needed)

---

## Appendix: Honest Comparison

### What ACTUALLY exceeds TradingView:

1. **HiDPI sharpness** — devicePixelContentBox is newer and more precise than devicePixelRatio multiplication
2. **Momentum feel** — tuned to match iOS, which is the gold standard
3. **Measured performance** — we have a harness, we know our numbers

### What MATCHES TradingView:

- 60fps pan/zoom
- Candlestick rendering
- Crosshair behavior
- Basic indicators

### What's WORSE than TradingView (for now):

- Feature count (they have years of development)
- Drawing tools (we have none in V1)
- Indicator library (they have 100+, we have 2)
- Multi-chart (they have it, we don't)

### Our Strategy:

Be **better at the core experience** (feel, sharpness, responsiveness) while being **worse at features**. Features can be added; feel is hard to retrofit.

---

## Final Checklist

Before starting implementation, confirm:

- [ ] 3-layer architecture is acceptable (not 4)
- [ ] Euler momentum is acceptable (not analytic spring)
- [ ] No rubber-band in V1 is acceptable
- [ ] SMA/EMA are the only V1 indicators
- [ ] 2-week timeline is realistic for your team
- [ ] Success criteria are agreed upon

---

*This is the minimal spec that achieves the goal. Every line is necessary. Nothing is over-engineered.*
