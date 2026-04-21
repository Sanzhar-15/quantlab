# V8 FINAL - Single Source of Truth

**IGNORE ALL OTHER V8 FILES. This is the only document that matters.**

---

## Critical Realization: Bar Thickness Issue

The user said bars get thicker "even by a very tiny distance" — meaning it happens **instantly when drag starts**, not gradually during drag.

This points to ONE likely cause: **The system switches rendering modes when drag begins.**

### Most Probable Causes (In Order)

**1. Line Width Change**
```typescript
// Somewhere in the code, this might happen:
onDragStart() {
  // Some optimization that accidentally changes line width
  ctx.lineWidth = 2;  // Was 1 before
}
```

**2. Different Canvas/Context Being Used**
```typescript
// Main render uses one canvas
// Drag render uses a different canvas with different settings
onDragStart() {
  this.activeCanvas = this.panCacheCanvas;  // Different canvas!
}
```

**3. Anti-Aliasing Toggle**
```typescript
// Main render has anti-aliasing off
// Pan cache has it on (or vice versa)
mainCtx.imageSmoothingEnabled = false;
cacheCtx.imageSmoothingEnabled = true;  // Different!
```

**4. DPR Mismatch**
```typescript
// Main canvas at 2x DPR
mainCanvas.width = 1000 * 2;  // 2000 physical pixels
// Cache canvas at 1x DPR  
cacheCanvas.width = 1000;      // 1000 physical pixels - WRONG
```

### Diagnostic Script (RUN THIS FIRST)

```typescript
// Add this to your chart class and check console when dragging:

onDragStart(event) {
  console.log('=== DRAG START DIAGNOSTICS ===');
  
  // Canvas dimensions
  console.log('Main canvas:', {
    physicalWidth: this.mainCanvas.width,
    physicalHeight: this.mainCanvas.height,
    cssWidth: this.mainCanvas.clientWidth,
    cssHeight: this.mainCanvas.clientHeight,
    dprRatio: this.mainCanvas.width / this.mainCanvas.clientWidth,
  });
  
  if (this.panCache?.canvas) {
    console.log('Pan cache canvas:', {
      physicalWidth: this.panCache.canvas.width,
      physicalHeight: this.panCache.canvas.height,
      cssWidth: this.panCache.canvas.clientWidth || 'N/A',
      dprRatio: this.panCache.canvas.width / (this.panCache.canvas.clientWidth || this.mainCanvas.clientWidth),
    });
  }
  
  // Context settings that affect appearance
  const ctx = this.ctx;
  console.log('Main context settings:', {
    lineWidth: ctx.lineWidth,
    imageSmoothingEnabled: ctx.imageSmoothingEnabled,
    globalAlpha: ctx.globalAlpha,
    globalCompositeOperation: ctx.globalCompositeOperation,
    transform: ctx.getTransform(),
  });
  
  if (this.panCache?.ctx) {
    const cacheCtx = this.panCache.ctx;
    console.log('Cache context settings:', {
      lineWidth: cacheCtx.lineWidth,
      imageSmoothingEnabled: cacheCtx.imageSmoothingEnabled,
      globalAlpha: cacheCtx.globalAlpha,
      transform: cacheCtx.getTransform(),
    });
  }
  
  console.log('Device pixel ratio:', window.devicePixelRatio);
  
  // Track what happens during first render after drag starts
  this._debugFirstDragRender = true;
}

// Add this to your render function:
render() {
  if (this._debugFirstDragRender && this.isDragging) {
    console.log('=== FIRST DRAG RENDER ===');
    console.log('Render mode:', this.panCache?.isActive ? 'PAN_CACHE_BLIT' : 'FULL_RENDER');
    
    if (this.panCache?.isActive) {
      console.log('Pan cache blit offset:', {
        raw: this.panCache.offset,
        rounded: Math.round(this.panCache.offset),
        isInteger: Number.isInteger(this.panCache.offset),
      });
    }
    
    console.log('Bar width being used:', this.calculatedBarWidth || 'unknown');
    this._debugFirstDragRender = false;
  }
  
  // ... rest of render
}

onDragEnd(event) {
  console.log('=== DRAG END ===');
}
```

**What to look for in the output:**

| Finding | Likely Cause | Fix |
|---------|--------------|-----|
| Cache canvas DPR ≠ main canvas DPR | DPR mismatch | Match DPR when creating cache |
| lineWidth differs between contexts | Line width bug | Use consistent lineWidth |
| imageSmoothingEnabled differs | Anti-aliasing mismatch | Set both to false |
| transform differs | Scale mismatch | Apply same scale to both |
| Pan offset is not integer | Sub-pixel blit blur | Round offset before blit |
| Render mode is FULL_RENDER | No pan cache | Different issue - check bar width calculation |

### The Fix (Once Diagnosed)

**If line width changes:**
```typescript
// Find where lineWidth is set and ensure it's consistent
// Search codebase for: lineWidth, ctx.lineWidth
```

**If canvas switches with different DPR:**
```typescript
// Ensure pan cache canvas has same DPR as main canvas
createPanCache() {
  const dpr = window.devicePixelRatio;
  this.cacheCanvas.width = this.width * dpr;
  this.cacheCanvas.height = this.height * dpr;
  this.cacheCtx.scale(dpr, dpr);
}
```

**If anti-aliasing differs:**
```typescript
// Ensure same setting on both contexts
this.mainCtx.imageSmoothingEnabled = false;
this.cacheCtx.imageSmoothingEnabled = false;  // Must match!
```

---

## Issue 4: Candles Shifting During Drag

### Root Cause
Floating point accumulation when using incremental updates:
```typescript
// WRONG
this.viewFrom += deltaX / scale;  // Accumulates error
```

### The Fix
```typescript
interface DragState {
  startViewFrom: number;
  startViewTo: number;
  startMouseX: number;
}

class Viewport {
  private drag: DragState | null = null;
  
  onDragStart(mouseX: number): void {
    this.drag = {
      startViewFrom: this.viewFrom,
      startViewTo: this.viewTo,
      startMouseX: mouseX,
    };
  }
  
  onDragMove(mouseX: number): void {
    if (!this.drag) return;
    
    // TOTAL delta from start
    const totalDeltaPx = mouseX - this.drag.startMouseX;
    const span = this.drag.startViewTo - this.drag.startViewFrom;
    const pxPerMs = this.plotWidth / span;
    const totalDeltaMs = totalDeltaPx / pxPerMs;
    
    // Always calculate from START values
    this.viewFrom = this.drag.startViewFrom - totalDeltaMs;
    this.viewTo = this.drag.startViewTo - totalDeltaMs;
  }
  
  onDragEnd(): void {
    this.drag = null;
  }
}
```

### Boundary Handling

When viewport hits a boundary and user reverses direction:

```typescript
onDragMove(mouseX: number): void {
  if (!this.drag) return;
  
  // Calculate proposed viewport
  const totalDeltaPx = mouseX - this.drag.startMouseX;
  const span = this.drag.startViewTo - this.drag.startViewFrom;
  const pxPerMs = this.plotWidth / span;
  const totalDeltaMs = totalDeltaPx / pxPerMs;
  
  let newFrom = this.drag.startViewFrom - totalDeltaMs;
  let newTo = this.drag.startViewTo - totalDeltaMs;
  
  // Apply boundaries
  const bounds = this.getScrollBounds();
  if (bounds) {
    let hitBoundary = false;
    
    if (newFrom < bounds.minFrom) {
      newFrom = bounds.minFrom;
      newTo = newFrom + span;
      hitBoundary = true;
    }
    if (newTo > bounds.maxTo) {
      newTo = bounds.maxTo;
      newFrom = newTo - span;
      hitBoundary = true;
    }
    
    // Reset drag origin when hitting boundary
    // This prevents jump when reversing direction
    if (hitBoundary) {
      this.drag.startViewFrom = newFrom;
      this.drag.startViewTo = newTo;
      this.drag.startMouseX = mouseX;
    }
  }
  
  this.viewFrom = newFrom;
  this.viewTo = newTo;
}
```

---

## Issue 3: Drag Smoothness

After fixing issues 1 and 4, smoothness should improve significantly. If still not smooth:

### Check 1: RAF Usage
```typescript
// WRONG - updating state outside RAF
onPointerMove(e) {
  this.viewport.pan(e.movementX);
  this.render();  // Synchronous render - BAD
}

// RIGHT - batch with RAF
onPointerMove(e) {
  this.pendingDelta += e.movementX;
  if (!this.rafPending) {
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.viewport.pan(this.pendingDelta);
      this.pendingDelta = 0;
      this.render();
      this.rafPending = false;
    });
  }
}
```

### Check 2: Avoid Layout Thrashing
```typescript
// WRONG - reading layout during render
render() {
  const width = this.canvas.offsetWidth;  // Forces layout!
  // ...
}

// RIGHT - cache dimensions
onResize() {
  this.cachedWidth = this.canvas.offsetWidth;
}
render() {
  const width = this.cachedWidth;  // No layout
  // ...
}
```

---

## Issue 2: Zoom to 3 Candlesticks

```typescript
const MIN_VISIBLE_BARS = 3;

onZoom(factor: number, anchorTime: number): void {
  const currentSpan = this.viewTo - this.viewFrom;
  let newSpan = currentSpan / factor;
  
  // Enforce minimum
  const minSpan = MIN_VISIBLE_BARS * this.barInterval;
  if (newSpan < minSpan) {
    newSpan = minSpan;
  }
  
  // Apply with anchor
  const anchorRatio = (anchorTime - this.viewFrom) / currentSpan;
  this.viewFrom = anchorTime - newSpan * anchorRatio;
  this.viewTo = anchorTime + newSpan * (1 - anchorRatio);
}
```

---

## Issue 5: Crosshair Mode

**Default:** Continuous (follows mouse exactly)
**Magnet:** Snaps to bar centers (toggle via toolbar or Shift key)

```typescript
class Crosshair {
  mode: 'continuous' | 'magnet' = 'continuous';
  
  onMouseMove(mouseX: number, mouseY: number): void {
    if (this.mode === 'magnet' || this.isShiftHeld) {
      const nearestBar = this.findNearestBar(mouseX);
      this.x = nearestBar ? this.timeToX(nearestBar.time) : mouseX;
    } else {
      this.x = mouseX;  // Exact mouse position
    }
    this.y = mouseY;
  }
  
  toggleMode(): void {
    this.mode = this.mode === 'continuous' ? 'magnet' : 'continuous';
  }
}
```

---

## Issue 6: Zoom Sensitivity

Multiplicative zoom is already proportional. Keep it simple:

```typescript
onWheel(event: WheelEvent): void {
  event.preventDefault();
  
  // 10% zoom per scroll "click"
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  
  // Right-edge anchor by default, cursor anchor with Ctrl
  const anchor = event.ctrlKey 
    ? this.xToTime(event.clientX)
    : this.viewTo;
  
  this.zoom(factor, anchor);
}
```

**Do NOT implement complex adaptive sensitivity.** It adds bugs without significant UX improvement.

---

## Issue 7: Scroll + Drag Conflict

Simple solution: ignore zoom while dragging.

```typescript
onWheel(event: WheelEvent): void {
  if (this.isDragging) {
    event.preventDefault();
    return;  // Ignore zoom during drag
  }
  // ... normal zoom
}
```

---

## Implementation Order

1. **RUN DIAGNOSTICS** for bar thickness issue (see script above)
2. **FIX** whatever the diagnostics reveal (DPR, lineWidth, canvas switch, etc.)
3. **IMPLEMENT** origin + delta pattern for drag
4. **SET** zoom minimum to 3 bars
5. **ADD** crosshair mode toggle
6. **SET** right-edge zoom as default
7. **ADD** drag-blocks-zoom safeguard
8. **TEST** smoothness, if still not smooth check RAF usage

---

## Verification Tests

After implementation:

| Test | Expected Result |
|------|-----------------|
| Start drag, look at bar width | Width stays EXACTLY same |
| Drag left/right for 60 seconds | No candle drift |
| Zoom in maximum | Shows exactly 3 bars |
| Move crosshair (default mode) | Follows mouse exactly |
| Hold Shift + move crosshair | Snaps to bar centers |
| Zoom without Ctrl | Right edge stays fixed |
| Scroll while dragging | Nothing happens (ignored) |
| Overall drag feel | Smooth, "locked in" |

---

## Scroll Bounds Definition

The `getScrollBounds()` method referenced in the boundary handling section:

```typescript
interface ScrollBounds {
  minFrom: number;  // Leftmost viewFrom allowed
  maxTo: number;    // Rightmost viewTo allowed
}

getScrollBounds(): ScrollBounds | null {
  const data = this.getData();
  if (!data || data.length === 0) return null;
  
  const firstBarTime = data[0].time;
  const lastBarTime = data[data.length - 1].time;
  const barInterval = data.length > 1 ? data[1].time - data[0].time : 60000;
  
  const currentSpan = this.viewTo - this.viewFrom;
  const minVisibleBars = 5;  // Keep at least 5 bars visible
  const minVisibleSpan = minVisibleBars * barInterval;
  const whitespace = Math.max(0, currentSpan - minVisibleSpan);
  
  return {
    minFrom: firstBarTime - whitespace,
    maxTo: lastBarTime + barInterval + whitespace,
  };
}
```

---

## Momentum After Drag Release

The origin + delta pattern doesn't naturally track velocity. Add explicit velocity tracking:

```typescript
class VelocityTracker {
  private samples: Array<{x: number, t: number}> = [];
  
  addSample(x: number): void {
    const t = performance.now();
    this.samples.push({x, t});
    // Keep last 5 samples
    if (this.samples.length > 5) this.samples.shift();
  }
  
  getVelocity(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = last.t - first.t;
    if (dt < 16) return 0;  // Too short
    return (last.x - first.x) / dt;  // px/ms
  }
  
  reset(): void {
    this.samples = [];
  }
}

// Usage in drag handler:
onDragStart(mouseX) {
  this.velocityTracker.reset();
  this.velocityTracker.addSample(mouseX);
  // ... rest of drag start
}

onDragMove(mouseX) {
  this.velocityTracker.addSample(mouseX);
  // ... rest of drag move
}

onDragEnd() {
  const velocity = this.velocityTracker.getVelocity();
  if (Math.abs(velocity) > 0.1) {
    this.startMomentum(velocity);
  }
  // ... rest of drag end
}
```

---

## Performance Note: Crosshair

For large datasets (100k+ points), `findNearestBar` is O(log n) which is fast. But avoid calling it synchronously on every `mousemove`. Use RAF:

```typescript
class Crosshair {
  private pendingX: number | null = null;
  
  onMouseMove(x: number, y: number): void {
    this.pendingX = x;
    this.pendingY = y;
    
    if (!this.rafPending) {
      this.rafPending = true;
      requestAnimationFrame(() => {
        this.updatePosition(this.pendingX!, this.pendingY!);
        this.rafPending = false;
      });
    }
  }
}
```

---

## If Using WebGL

All the canvas 2D advice above assumes Canvas 2D API. If using WebGL:

- Bar width issues could be shader-related or uniform-related
- DPR handling is different (viewport vs canvas size)
- Line thickness is handled differently

Check your renderer type first.

---

## Summary: What To Do

1. **Run the diagnostic script** — this identifies the bar thickness cause
2. **Fix whatever the diagnostics reveal** — usually DPR, lineWidth, or canvas switch
3. **Implement origin + delta drag** — with boundary reset and velocity tracking
4. **Add the simple fixes** — zoom limit, crosshair modes, right-edge zoom
5. **Test against the verification table**

**Total implementation time:** 2-4 hours if diagnostics point to a clear cause.

---

## Note for Cursor

Ignore all other V8 spec files (01-09). They contain earlier iterations with errors and contradictions. This single file (V8-FINAL.md) contains everything needed, corrected and consolidated.
