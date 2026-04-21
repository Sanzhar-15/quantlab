# V7 Spec Improvements & Additions

After deep review, I found gaps and edge cases that need addressing. This file contains improvements to integrate into the existing specs.

---

## Critical: Frame Execution Order

When multiple V7 features interact in the same frame, execute in this order:

```typescript
function executeFrame(currentTime: number): void {
  // 1. PHYSICS UPDATE (01-DELTATIME-CAP)
  const dt = Math.min(currentTime - lastTime, 100);
  physics.update(dt);
  rubberBand.update(dt);
  springs.update(dt);
  
  // 2. INPUT PROCESSING (12-POINTER-CAPTURE)
  const input = inputCoalescer.process();
  
  // 3. VIEWPORT UPDATE (09, 10)
  if (input.drag) {
    viewport.applyDrag(input.drag);
    scrollBoundary.clamp(viewport);  // 09-SCROLL-BOUNDARIES
  }
  if (input.zoom) {
    if (input.zoom.ctrlKey) {
      viewport.zoomCursorAnchored(input.zoom);
    } else {
      viewport.zoomRightAnchored(input.zoom);  // 10-RIGHT-EDGE-ZOOM
    }
  }
  
  // 4. Y-AXIS UPDATE (04-YAXIS-LOCK-DRAG)
  if (!interactionState.isDragging) {
    priceScale.autoScale(visibleData);
  }
  
  // 5. LAYOUT (05-AXIS-WIDTH-HYSTERESIS)
  const axisWidth = axisWidthController.update(ticks, interactionState.isDragging);
  layout.calculate(axisWidth);
  
  // 6. TICK/LABEL GENERATION (07-LABEL-FORMAT-STABILITY)
  const format = labelFormatter.selectFormat(msPerPixel);
  const ticks = tickGenerator.generate(viewport, format);
  
  // 7. SNAPSHOT CAPTURE (02-FRAME-COHERENCE)
  const snapshot = captureRenderState(viewport, ticks, layout);
  
  // 8. RENDER DECISION (02-FRAME-COHERENCE)
  const budget = new FrameBudget(12);
  const shouldRenderCoherent = budget.canRender('coherent');
  
  // 9. RENDER COHERENT GROUP (03-PIXEL-PERFECT-PAN, 08-OPAQUE-LAYERS)
  if (shouldRenderCoherent) {
    renderBackground(snapshot);  // opaque
    renderGrid(snapshot);        // pixel-snapped
    renderSeries(snapshot);      // pixel-perfect pan
    renderAxes(snapshot);        // pixel-snapped
    lastCoherentSnapshot = snapshot;
  }
  
  // 10. RENDER OVERLAY (11-CROSSHAIR-SNAP) - always renders
  const crosshairPos = findNearestBar(mousePosition);
  renderCrosshair(crosshairPos);
}
```

---

## 01-DELTATIME-CAP: Missing First Frame Handling

**Gap:** If `lastTime` is 0 or uninitialized, the first `dt` calculation will be huge.

**Add to Implementation Guide:**

```typescript
class SpringAnimation {
  private lastTime: number | null = null;  // null = not started
  
  update(currentTime: number): SpringState {
    // FIRST FRAME: Initialize lastTime, use nominal dt
    if (this.lastTime === null) {
      this.lastTime = currentTime;
      return this.step(16.67);  // Assume 60fps for first frame
    }
    
    const rawDt = currentTime - this.lastTime;
    const dt = Math.min(rawDt, 100);
    this.lastTime = currentTime;
    
    // ... rest of logic
  }
}
```

---

## 02-FRAME-COHERENCE: Missing Overlay Handling

**Gap:** Spec doesn't clarify that overlay (crosshair) should ALWAYS render, even when coherent layers are skipped.

**Add to Specification:**

```
Layers are grouped as:
1. COHERENT GROUP: grid, series, yAxis, xAxis - must all use same snapshot
2. INDEPENDENT: overlay (crosshair, tooltips) - always renders with latest state

When coherent layers are skipped:
- Overlay still updates (crosshair follows mouse)
- Coherent layers show previous frame
```

**Add to Code Pattern:**

```typescript
function renderFrame(currentSnapshot: RenderStateSnapshot): void {
  const coherentRendered = this.tryRenderCoherentGroup(currentSnapshot);
  
  // Overlay ALWAYS renders, regardless of coherent group status
  // Uses current mouse position, not snapshot
  this.renderOverlay(this.getCurrentPointerPosition());
}
```

---

## 03-PIXEL-PERFECT-PAN: Missing Grid/Axis Line Snapping

**Gap:** Spec focuses on pan cache blitting but doesn't mention that grid lines and axis tick marks also need pixel snapping.

**Add to Implementation Guide:**

```typescript
// Grid line rendering must also snap to physical pixels
function drawGridLine(ctx: CanvasRenderingContext2D, y: number, dpr: number): void {
  // Snap to physical pixel boundary
  const physicalY = Math.round(y * dpr) / dpr;
  const snappedY = Math.round(physicalY) + 0.5;  // Center of pixel
  
  ctx.beginPath();
  ctx.moveTo(0, snappedY);
  ctx.lineTo(width, snappedY);
  ctx.stroke();
}

// Same for vertical lines (time axis)
function drawVerticalLine(ctx: CanvasRenderingContext2D, x: number, dpr: number): void {
  const physicalX = Math.round(x * dpr) / dpr;
  const snappedX = Math.round(physicalX) + 0.5;
  
  ctx.beginPath();
  ctx.moveTo(snappedX, 0);
  ctx.lineTo(snappedX, height);
  ctx.stroke();
}
```

---

## 04-YAXIS-LOCK-DRAG: Missing Multi-Pane Handling

**Gap:** Each indicator pane (RSI, MACD, etc.) has its own Y-axis. All should freeze during drag.

**Add to Specification:**

```
When main chart drag starts:
- Freeze Y-axis on main chart
- Freeze Y-axis on ALL indicator panes
- All unfreeze together when drag ends
```

**Add to Code Pattern:**

```typescript
class ChartPaneManager {
  private panes: ChartPane[] = [];
  
  freezeAllYAxes(): void {
    for (const pane of this.panes) {
      pane.priceScale.freeze();
    }
  }
  
  unfreezeAllYAxes(): void {
    for (const pane of this.panes) {
      pane.priceScale.unfreeze();
    }
  }
}
```

---

## 06-DPR-CEILING: Missing DPR Change Detection

**Gap:** User might drag window between displays with different DPRs. Need to detect and handle this.

**Add to Implementation Guide:**

```typescript
class DprMonitor {
  private currentDpr: number;
  private mediaQuery: MediaQueryList;
  private onDprChange: (newDpr: number) => void;
  
  constructor(onDprChange: (newDpr: number) => void) {
    this.currentDpr = window.devicePixelRatio;
    this.onDprChange = onDprChange;
    
    // Monitor DPR changes (window moved between displays)
    this.mediaQuery = window.matchMedia(
      `(resolution: ${this.currentDpr}dppx)`
    );
    
    this.mediaQuery.addEventListener('change', this.handleChange);
    
    // Also check on resize (backup)
    window.addEventListener('resize', this.checkDpr);
  }
  
  private handleChange = (): void => {
    this.checkDpr();
  };
  
  private checkDpr = (): void => {
    const newDpr = window.devicePixelRatio;
    if (newDpr !== this.currentDpr) {
      this.currentDpr = newDpr;
      this.onDprChange(newDpr);
    }
  };
  
  destroy(): void {
    this.mediaQuery.removeEventListener('change', this.handleChange);
    window.removeEventListener('resize', this.checkDpr);
  }
}

// Usage
const dprMonitor = new DprMonitor((newDpr) => {
  // Recalculate effective DPR and resize canvases
  chart.handleDprChange(newDpr);
});
```

---

## 07-LABEL-FORMAT-STABILITY: Missing Context-Aware Labels

**Gap:** When viewing minute data, should still show date when crossing day boundaries.

**Add to Specification:**

```
Context-aware labeling rules:
1. Primary format based on zoom level (as specified)
2. At significant boundaries, show additional context:
   - Minute view: Show date at midnight (00:00)
   - Hour view: Show date at start of each day
   - Day view: Show month at start of each month
   - Month view: Show year at start of each year
```

**Add to Code Pattern:**

```typescript
function formatTimeLabel(
  timestamp: number,
  primaryFormat: TimeLabelFormat,
  previousTimestamp: number | null
): string {
  const date = new Date(timestamp);
  const prevDate = previousTimestamp ? new Date(previousTimestamp) : null;
  
  // Check if we crossed a significant boundary
  const crossedDay = prevDate && date.getDate() !== prevDate.getDate();
  const crossedMonth = prevDate && date.getMonth() !== prevDate.getMonth();
  const crossedYear = prevDate && date.getFullYear() !== prevDate.getFullYear();
  
  // Context-aware formatting
  if (primaryFormat <= TimeLabelFormat.Hours && crossedDay) {
    // In minute/hour view, show date at day boundary
    return formatDays(timestamp);  // "Jan 8"
  }
  
  if (primaryFormat === TimeLabelFormat.Days && crossedMonth) {
    // In day view, show month at month boundary
    return formatMonths(timestamp);  // "February"
  }
  
  if (primaryFormat === TimeLabelFormat.Months && crossedYear) {
    // In month view, show year at year boundary
    return formatYears(timestamp);  // "2026"
  }
  
  // Default: use primary format
  return formatByLevel(timestamp, primaryFormat);
}
```

---

## 09-SCROLL-BOUNDARIES: Missing Data Update Handling

**Gap:** When new data arrives (streaming), boundaries should update without user action.

**Add to Specification:**

```
Boundary update triggers:
1. Initial data load
2. New data appended (streaming)
3. Data replaced/reset
4. Zoom level change

On new data append:
- If user is at right edge (viewing latest), auto-scroll to keep latest visible
- Update boundaries to include new data
- If user is NOT at right edge, don't auto-scroll (they're looking at history)
```

**Add to Code Pattern:**

```typescript
class ScrollBoundaryController {
  private isAtRightEdge: boolean = true;
  
  onDataAppended(newLastTime: number): void {
    // Update extent
    this.dataExtent.lastBarTime = newLastTime;
    this.dataExtent.totalBars++;
    
    // Auto-scroll if user was at right edge
    if (this.isAtRightEdge) {
      this.scrollToShowLatest();
    }
  }
  
  onViewportChange(from: number, to: number): void {
    // Check if user is at right edge (within 1 bar)
    const threshold = this.dataExtent.barInterval;
    this.isAtRightEdge = (this.dataExtent.lastBarTime - to) < threshold;
  }
}
```

---

## 10-RIGHT-EDGE-ZOOM: Missing Trackpad Pinch Handling

**Gap:** Trackpad pinch gestures may not have a clear "cursor position" or Ctrl state.

**Add to Specification:**

```
Trackpad pinch behavior:
- Default: Right-edge anchor (same as scroll wheel)
- Pinch center is ignored for anchor calculation
- Two-finger pan = pan (not zoom)

Touch screen pinch:
- Uses pinch center as anchor (cursor-anchor mode)
- This matches user expectation on touch devices
```

**Add to Code Pattern:**

```typescript
class GestureHandler {
  handleGesture(event: GestureEvent): void {
    if (event.type === 'pinch') {
      if (event.pointerType === 'touch') {
        // Touch screen: anchor to pinch center
        this.zoom.cursorAnchored(event.scale, event.centerX);
      } else {
        // Trackpad: anchor to right edge
        this.zoom.rightAnchored(event.scale);
      }
    }
  }
}
```

---

## 11-CROSSHAIR-SNAP: Missing Gap Handling

**Gap:** What happens when crosshair is over a gap in data (e.g., weekend on daily chart)?

**Add to Specification:**

```
Gap handling for crosshair:
1. If mouse is over a gap, snap to the NEAREST bar (before or after gap)
2. Visual indication: crosshair line could be dashed/dimmed in gap areas
3. Time label shows the snapped bar's time, not the gap time
4. Tooltip shows "No data" or nothing in gap regions
```

**Add to Code Pattern:**

```typescript
function findNearestBarWithGapHandling(
  mouseTime: number,
  data: OhlcBar[],
  maxGapMs: number  // Gap threshold (e.g., 3 days for daily data)
): { bar: OhlcBar; isInGap: boolean } | null {
  const nearest = findNearestBar(mouseTime, data);
  if (!nearest) return null;
  
  const distance = Math.abs(nearest.time - mouseTime);
  const isInGap = distance > maxGapMs;
  
  return {
    bar: nearest,
    isInGap,
  };
}

// In render:
if (crosshairState.isInGap) {
  ctx.setLineDash([2, 4]);  // Dashed line in gap
  ctx.globalAlpha = 0.5;    // Dimmed
}
```

---

## 11-CROSSHAIR-SNAP: Missing Edge Behavior

**Gap:** What happens at edges of data? Should crosshair work beyond first/last bar?

**Add to Specification:**

```
Edge behavior:
1. Crosshair only active within plot area
2. If mouse is before first bar: snap to first bar
3. If mouse is after last bar: snap to last bar
4. Crosshair vertical line stays within data range (doesn't extend into whitespace)
```

---

## General: Missing Touch Support Details

Several specs need explicit touch handling. Add to relevant specs:

**Touch-specific considerations:**

```typescript
// Touch events have different characteristics:
// 1. No hover state (crosshair only shows during touch)
// 2. Touch targets need larger hit areas
// 3. Long-press for context menu instead of right-click
// 4. Pinch is zoom, two-finger pan is pan

class TouchHandler {
  // Crosshair: show on touch start, hide on touch end
  onTouchStart(e: TouchEvent): void {
    this.crosshair.show();
    this.crosshair.moveTo(e.touches[0].clientX, e.touches[0].clientY);
  }
  
  onTouchEnd(e: TouchEvent): void {
    // Delay hide to allow reading values
    setTimeout(() => this.crosshair.hide(), 1500);
  }
}
```

---

## General: Missing Animation Interrupt Handling

When user starts a new interaction during an animation:

```typescript
class AnimationController {
  private activeAnimation: Animation | null = null;
  
  startAnimation(animation: Animation): void {
    // Interrupt any existing animation
    if (this.activeAnimation) {
      this.activeAnimation.stop();
    }
    
    this.activeAnimation = animation;
    animation.start();
  }
  
  onUserInteractionStart(): void {
    // Cancel animations when user takes control
    if (this.activeAnimation) {
      this.activeAnimation.stop();
      this.activeAnimation = null;
    }
  }
}
```

---

## General: Missing Error Boundaries

All specs should have graceful error handling:

```typescript
// Wrap critical operations
function safeRender(renderFn: () => void): void {
  try {
    renderFn();
  } catch (error) {
    console.error('Render error:', error);
    // Don't crash - show fallback or skip frame
    this.showErrorState();
  }
}

// For physics/math, guard against NaN/Infinity
function safePhysicsUpdate(value: number): number {
  if (!Number.isFinite(value)) {
    console.warn('Physics produced non-finite value, resetting');
    return 0;
  }
  return value;
}
```

---

## Summary of Additions

| Spec | Addition |
|------|----------|
| 01 | First frame initialization |
| 02 | Overlay always renders |
| 03 | Grid/axis line pixel snapping |
| 04 | Multi-pane Y-axis freeze |
| 06 | DPR change detection |
| 07 | Context-aware boundary labels |
| 09 | Streaming data auto-scroll |
| 10 | Trackpad vs touch pinch |
| 11 | Gap handling, edge behavior |
| All | Touch support details |
| All | Animation interrupt handling |
| All | Error boundaries |

These additions make the specs production-complete.

---

## Critical: Integration Verification

After implementing all specs, run this integration test:

```typescript
describe('V7 Integration', () => {
  it('should handle rapid interaction sequence without errors', async () => {
    const chart = createChart(container, { data: generateTestData(10000) });
    
    // Sequence that exercises all V7 features
    await simulateDrag(chart, { x: 0, y: 0 }, { x: 500, y: 0 }); // Tests 03, 04, 05, 12
    await simulateWheel(chart, { deltaY: -100 }); // Tests 10
    await simulateWheel(chart, { deltaY: -100, ctrlKey: true }); // Tests 10 (cursor anchor)
    await simulatePanToEdge(chart, 'right'); // Tests 09
    await simulateCrosshairMove(chart, { x: 400, y: 300 }); // Tests 11
    await simulateTabSwitch(5000); // Tests 01
    await simulateResize(chart, 1920, 1080); // Tests 06
    
    // Verify no errors occurred
    expect(chart.getErrorCount()).toBe(0);
    
    // Verify frame coherence
    const snapshot = chart.getRenderSnapshot();
    expect(snapshot.gridTimeRange).toEqual(snapshot.seriesTimeRange);
    
    // Verify crosshair is snapped to bar
    const crosshair = chart.getCrosshairState();
    const nearestBar = chart.findBarAtTime(crosshair.time);
    expect(crosshair.time).toBe(nearestBar.time);
  });
});
```

---

## Critical: Performance Regression Tests

Each spec should not regress performance. Add these benchmarks:

```typescript
// Run before and after V7 implementation
const PERF_BUDGETS = {
  panFrameTime: 3,      // ms (was 3ms, should stay ≤3ms)
  zoomFrameTime: 18,    // ms (was 18ms, should stay ≤18ms)
  crosshairFrameTime: 1, // ms (was <1ms, should stay ≤1ms)
  memoryIncrease: 0.1,  // 10% max increase
};

describe('V7 Performance', () => {
  it('should not regress pan performance', async () => {
    const times = await measurePanFrameTimes(100);
    expect(percentile(times, 95)).toBeLessThanOrEqual(PERF_BUDGETS.panFrameTime);
  });
  
  // ... similar for other operations
});
```

---

## Critical: Rollback Strategy

If V7 causes issues in production, enable rollback via feature flags:

```typescript
// Feature flags for each V7 item
const V7_FLAGS = {
  deltaCap: true,          // 01
  frameCoherence: true,    // 02
  pixelPerfectPan: true,   // 03
  yAxisLock: true,         // 04
  axisWidthHysteresis: true, // 05
  dprCeiling: true,        // 06
  labelFormatStability: true, // 07
  opaqueLayers: true,      // 08
  scrollBoundaries: true,  // 09
  rightEdgeZoom: true,     // 10
  crosshairSnap: true,     // 11
  pointerCapture: true,    // 12
};

// Usage in code:
if (V7_FLAGS.pixelPerfectPan) {
  this.panCache.drawPixelPerfect(ctx);
} else {
  this.panCache.drawLegacy(ctx);
}
```

---

## Critical: Keyboard Accessibility (11-CROSSHAIR-SNAP)

**Gap:** Crosshair is mouse-only. Need keyboard navigation for accessibility.

**Add to 11-CROSSHAIR-SNAP:**

```typescript
class KeyboardCrosshair {
  private currentBarIndex: number = 0;
  
  handleKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowLeft':
        this.moveToBar(this.currentBarIndex - 1);
        event.preventDefault();
        break;
      case 'ArrowRight':
        this.moveToBar(this.currentBarIndex + 1);
        event.preventDefault();
        break;
      case 'Home':
        this.moveToBar(0);
        event.preventDefault();
        break;
      case 'End':
        this.moveToBar(this.data.length - 1);
        event.preventDefault();
        break;
    }
  }
  
  private moveToBar(index: number): void {
    index = Math.max(0, Math.min(this.data.length - 1, index));
    this.currentBarIndex = index;
    
    const bar = this.data[index];
    this.crosshair.snapToBar(bar);
    
    // Announce for screen readers
    this.announceBar(bar);
  }
  
  private announceBar(bar: OhlcBar): void {
    const announcement = `${this.formatTime(bar.time)}, ` +
      `Open ${bar.open}, High ${bar.high}, Low ${bar.low}, Close ${bar.close}`;
    
    this.ariaLive.textContent = announcement;
  }
}

// HTML needed:
// <div aria-live="polite" class="sr-only" id="chart-announcer"></div>
```

---

## File Checklist

Before considering V7 complete, verify:

- [ ] All 12 specs implemented
- [ ] All 13-ADDENDUM improvements integrated
- [ ] Feature flags in place for rollback
- [ ] Performance regression tests passing
- [ ] Integration test passing
- [ ] Keyboard accessibility working
- [ ] Touch interactions tested on real device
- [ ] High-DPI display tested (1.25x, 1.5x, 2x, 3x)
- [ ] Tab switch behavior tested
- [ ] Memory leak test (30 min continuous use) passing
