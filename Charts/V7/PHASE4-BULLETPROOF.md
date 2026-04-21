# Phase 4: User Experience Features (BULLETPROOF VERSION)

## ⛔ READ THIS FIRST - COMMON MISTAKES TO AVOID

### Mistake 1: Setting Viewport TO Boundaries
```typescript
// ⛔ WRONG - This zooms out to show ALL data
const bounds = calculateBounds();
this.viewFrom = bounds.minViewFrom;  // NO!
this.viewTo = bounds.maxViewTo;      // NO!

// ✅ RIGHT - Boundaries are LIMITS, not values
const bounds = calculateBounds();
if (this.viewFrom < bounds.minViewFrom) {
  this.viewFrom = bounds.minViewFrom;  // Only if exceeded
}
```

### Mistake 2: Replacing Pan Logic
```typescript
// ⛔ WRONG - Lost the actual panning
onPan(deltaX) {
  const bounds = calculateBounds();
  // Where's the actual pan???
}

// ✅ RIGHT - Add to existing pan, don't replace
onPan(deltaX) {
  // KEEP existing pan logic
  const deltaTime = deltaX / this.pixelsPerMs;
  let newFrom = this.viewFrom - deltaTime;
  let newTo = this.viewTo - deltaTime;
  
  // THEN add boundary check
  const bounds = calculateBounds();
  // ... clamp if needed
}
```

### Mistake 3: Applying Boundaries Every Frame
```typescript
// ⛔ WRONG - Clamping on render breaks everything
render() {
  this.clampToBounds();  // NO! Don't do this here
  this.draw();
}

// ✅ RIGHT - Only clamp during USER INPUT
onPan() { /* clamp here */ }
onZoom() { /* maybe clamp here */ }
render() { /* never clamp here */ }
```

### Mistake 4: Touching Initial Viewport
```typescript
// ⛔ WRONG - Don't modify initialization
initViewport() {
  const bounds = calculateBounds();
  // anything with bounds here is WRONG
}

// ✅ RIGHT - Leave initialization EXACTLY as it was
initViewport() {
  // Whatever was here before, KEEP IT
}
```

---

# STEP-BY-STEP IMPLEMENTATION

## Step 1: Find Your Existing Code (DO NOT MODIFY YET)

Find and **copy** these existing functions to understand them:

### 1A: Find Initial Viewport Setup
Search for code that sets the initial visible range when data loads.
```typescript
// It probably looks like one of these patterns:
setInitialRange() { ... }
onDataLoaded() { ... }
initViewport() { ... }
resetView() { ... }
```
**Write down the file and line number: ____________**

### 1B: Find Pan Handler
Search for code that handles dragging/panning.
```typescript
// It probably looks like one of these patterns:
onPan(delta) { ... }
onDrag(dx, dy) { ... }
handlePan(event) { ... }
onPointerMove() { /* with isDragging check */ }
```
**Write down the file and line number: ____________**

### 1C: Find Zoom Handler  
Search for code that handles zoom (wheel event).
```typescript
// It probably looks like one of these patterns:
onWheel(event) { ... }
onZoom(factor) { ... }
handleZoom(delta) { ... }
```
**Write down the file and line number: ____________**

### 1D: Find Crosshair Update
Search for code that updates crosshair position.
```typescript
// It probably looks like one of these patterns:
updateCrosshair(x, y) { ... }
onMouseMove(event) { /* crosshair update */ }
setCrosshairPosition(x, y) { ... }
```
**Write down the file and line number: ____________**

---

## Step 2: Implement Scroll Boundaries (09)

### 2A: Create NEW Utility File

Create a new file `src/utils/scroll-bounds.ts` (or similar path):

```typescript
// scroll-bounds.ts
// This file contains PURE FUNCTIONS - no side effects

export interface DataExtent {
  firstBarTime: number;
  lastBarTime: number;
  barInterval: number;
}

export interface ScrollBounds {
  minViewFrom: number;
  maxViewTo: number;
}

/**
 * Calculate the boundaries for panning.
 * These are LIMITS - the viewport should not exceed these.
 * They are NOT the viewport values themselves.
 * 
 * @param extent - The time range of available data
 * @param visibleSpan - Current viewport width in milliseconds (viewTo - viewFrom)
 * @param minVisibleBars - Minimum bars that must stay visible (default: 5)
 */
export function calculateScrollBounds(
  extent: DataExtent | null,
  visibleSpan: number,
  minVisibleBars: number = 5
): ScrollBounds | null {
  // No data = no bounds
  if (!extent || extent.barInterval <= 0) {
    return null;
  }
  
  // How much time does minVisibleBars represent?
  const minVisibleSpan = minVisibleBars * extent.barInterval;
  
  // How much whitespace can we allow?
  // If viewport shows 20 bars and min is 5, we can scroll 15 bars into whitespace
  const whitespaceAllowed = Math.max(0, visibleSpan - minVisibleSpan);
  
  return {
    // Left limit: can scroll until first bar is at right edge (minus min visible)
    minViewFrom: extent.firstBarTime - whitespaceAllowed,
    // Right limit: can scroll until last bar is at left edge (plus min visible)  
    maxViewTo: extent.lastBarTime + whitespaceAllowed,
  };
}

/**
 * Check if proposed viewport exceeds bounds.
 * Returns adjusted values ONLY if bounds are exceeded.
 * 
 * IMPORTANT: If bounds is null, returns proposed values unchanged.
 * IMPORTANT: This does NOT change the span (zoom level).
 */
export function clampToBounds(
  proposedFrom: number,
  proposedTo: number,
  bounds: ScrollBounds | null
): { from: number; to: number; clamped: boolean } {
  // No bounds = no clamping
  if (!bounds) {
    return { from: proposedFrom, to: proposedTo, clamped: false };
  }
  
  const span = proposedTo - proposedFrom;
  let from = proposedFrom;
  let to = proposedTo;
  let clamped = false;
  
  // Check left boundary
  if (from < bounds.minViewFrom) {
    from = bounds.minViewFrom;
    to = from + span;
    clamped = true;
  }
  
  // Check right boundary
  if (to > bounds.maxViewTo) {
    to = bounds.maxViewTo;
    from = to - span;
    clamped = true;
    
    // Re-check left (in case span > allowed range)
    if (from < bounds.minViewFrom) {
      from = bounds.minViewFrom;
      clamped = true;
    }
  }
  
  return { from, to, clamped };
}
```

### 2B: Add Helper to Get Data Extent

In your data store or chart class, add this method IF it doesn't exist:

```typescript
// Add to your data management class
getDataExtent(): DataExtent | null {
  const data = this.data; // or however you access data
  if (!data || data.length === 0) return null;
  
  // Calculate bar interval from first two bars
  let barInterval = 60000; // default 1 minute
  if (data.length >= 2) {
    barInterval = data[1].time - data[0].time;
  }
  
  return {
    firstBarTime: data[0].time,
    lastBarTime: data[data.length - 1].time,
    barInterval: barInterval,
  };
}
```

### 2C: Modify Pan Handler (CAREFULLY)

Find your existing pan handler and make MINIMAL changes:

```typescript
// BEFORE (your existing code - structure may vary)
onPan(deltaPixels: number): void {
  const deltaTime = deltaPixels / this.pixelsPerMs;
  const newFrom = this.viewFrom - deltaTime;
  const newTo = this.viewTo - deltaTime;
  this.setVisibleRange(newFrom, newTo);
}

// AFTER (add boundary check - keep everything else!)
import { calculateScrollBounds, clampToBounds } from './utils/scroll-bounds';

onPan(deltaPixels: number): void {
  // === KEEP YOUR EXISTING LOGIC ===
  const deltaTime = deltaPixels / this.pixelsPerMs;
  const proposedFrom = this.viewFrom - deltaTime;
  const proposedTo = this.viewTo - deltaTime;
  
  // === ADD THIS SECTION ===
  const extent = this.getDataExtent();
  const bounds = calculateScrollBounds(extent, proposedTo - proposedFrom);
  const result = clampToBounds(proposedFrom, proposedTo, bounds);
  // === END NEW SECTION ===
  
  // === MODIFY THIS LINE ===
  this.setVisibleRange(result.from, result.to);  // Use result, not proposed
}
```

### 2D: DO NOT Touch These Places

- ❌ Initial viewport setup
- ❌ Render loop  
- ❌ Zoom handler (for now)
- ❌ Data loading

---

## Step 3: Implement Right-Edge Zoom (10)

### 3A: Find Existing Zoom Handler

Your zoom handler probably looks like:

```typescript
// EXISTING zoom (cursor-anchored)
onWheel(event: WheelEvent): void {
  event.preventDefault();
  
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  const currentSpan = this.viewTo - this.viewFrom;
  const newSpan = currentSpan / factor;
  
  // Cursor anchor calculation
  const mouseX = event.clientX - this.rect.left;
  const mouseRatio = mouseX / this.width;
  const mouseTime = this.viewFrom + currentSpan * mouseRatio;
  
  const newFrom = mouseTime - newSpan * mouseRatio;
  const newTo = mouseTime + newSpan * (1 - mouseRatio);
  
  this.setVisibleRange(newFrom, newTo);
}
```

### 3B: Modify to Support Right-Edge Anchor

```typescript
// MODIFIED zoom (right-edge default, Ctrl for cursor)
onWheel(event: WheelEvent): void {
  event.preventDefault();
  
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  const currentSpan = this.viewTo - this.viewFrom;
  const newSpan = currentSpan / factor;
  
  // === KEEP: Clamp zoom level if you have limits ===
  // const clampedSpan = Math.max(minSpan, Math.min(maxSpan, newSpan));
  
  let newFrom: number;
  let newTo: number;
  
  // === NEW: Check for Ctrl key ===
  if (event.ctrlKey) {
    // Ctrl held: use cursor position as anchor (original behavior)
    const mouseX = event.clientX - this.rect.left;
    const mouseRatio = mouseX / this.width;
    const mouseTime = this.viewFrom + currentSpan * mouseRatio;
    
    newFrom = mouseTime - newSpan * mouseRatio;
    newTo = mouseTime + newSpan * (1 - mouseRatio);
  } else {
    // Default: right edge stays fixed
    newTo = this.viewTo;      // RIGHT EDGE UNCHANGED
    newFrom = newTo - newSpan; // Only left edge moves
  }
  
  this.setVisibleRange(newFrom, newTo);
}
```

### 3C: Test Immediately

1. Zoom without Ctrl → Right edge should stay fixed
2. Zoom with Ctrl → Point under cursor should stay fixed

---

## Step 4: Implement Crosshair Snap (11)

### 4A: Create Bar Finder Utility

```typescript
// bar-finder.ts
export interface BarInfo {
  index: number;
  time: number;
  bar: OhlcBar;
}

/**
 * Find the bar nearest to a time value using binary search.
 */
export function findNearestBar(
  targetTime: number,
  data: OhlcBar[]
): BarInfo | null {
  if (!data || data.length === 0) return null;
  
  // Binary search
  let left = 0;
  let right = data.length - 1;
  
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (data[mid].time < targetTime) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  
  // Check left and left-1 to find closest
  let bestIndex = left;
  let bestDist = Math.abs(data[left].time - targetTime);
  
  if (left > 0) {
    const leftDist = Math.abs(data[left - 1].time - targetTime);
    if (leftDist < bestDist) {
      bestIndex = left - 1;
      bestDist = leftDist;
    }
  }
  
  return {
    index: bestIndex,
    time: data[bestIndex].time,
    bar: data[bestIndex],
  };
}
```

### 4B: Modify Crosshair Update

Find your crosshair mouse move handler:

```typescript
// BEFORE
onMouseMove(event: MouseEvent): void {
  const x = event.clientX - this.rect.left;
  const y = event.clientY - this.rect.top;
  
  this.crosshairX = x;
  this.crosshairY = y;
  this.crosshairTime = this.xToTime(x);
  this.crosshairPrice = this.yToPrice(y);
}

// AFTER
import { findNearestBar } from './bar-finder';

onMouseMove(event: MouseEvent): void {
  const mouseX = event.clientX - this.rect.left;
  const mouseY = event.clientY - this.rect.top;
  
  // Convert mouse X to time
  const mouseTime = this.xToTime(mouseX);
  
  // Find nearest bar
  const nearest = findNearestBar(mouseTime, this.data);
  
  if (nearest) {
    // SNAP X to bar's time position
    this.crosshairX = this.timeToX(nearest.time);
    this.crosshairTime = nearest.time;
    this.crosshairBar = nearest.bar; // For tooltip
  } else {
    // No data - use mouse position
    this.crosshairX = mouseX;
    this.crosshairTime = mouseTime;
    this.crosshairBar = null;
  }
  
  // Y always follows mouse (no snap)
  this.crosshairY = mouseY;
  this.crosshairPrice = this.yToPrice(mouseY);
}
```

---

## Verification Checklist

After each step, verify:

### After Step 2 (Scroll Boundaries):
- [ ] Can still drag/pan the chart normally
- [ ] Initial viewport is same as before (not fully zoomed out)
- [ ] Can scroll right until ~5 bars visible on left
- [ ] Can scroll left until ~5 bars visible on right
- [ ] Hits boundary and stops (or rubber-bands)

### After Step 3 (Right-Edge Zoom):
- [ ] Zoom without Ctrl → right edge stays fixed
- [ ] Zoom with Ctrl → cursor position stays fixed
- [ ] Zoom limits still work (can't zoom too far in/out)
- [ ] Panning still works exactly as before

### After Step 4 (Crosshair Snap):
- [ ] Crosshair vertical line jumps from bar to bar
- [ ] Crosshair doesn't smoothly follow mouse (it snaps)
- [ ] Time label shows bar time (e.g., "Jan 8") not interpolated time
- [ ] Y position still follows mouse smoothly

---

## Emergency Rollback

If things break, undo in reverse order:

### Rollback Crosshair (Step 4):
```typescript
// Restore original onMouseMove
onMouseMove(event: MouseEvent): void {
  const x = event.clientX - this.rect.left;
  const y = event.clientY - this.rect.top;
  this.crosshairX = x;
  this.crosshairY = y;
  this.crosshairTime = this.xToTime(x);
  this.crosshairPrice = this.yToPrice(y);
}
```

### Rollback Zoom (Step 3):
```typescript
// Remove the if/else for ctrlKey, restore original cursor-anchor only
```

### Rollback Pan Boundaries (Step 2):
```typescript
// Remove the bounds calculation and clampToBounds call
// Use proposedFrom/proposedTo directly in setVisibleRange
```

---

## Debugging

### "Initial viewport is fully zoomed out"

This means boundaries are being applied at initialization. Search for:
```typescript
// Look for this pattern and REMOVE it
calculateScrollBounds  // in any initialization code
clampToBounds          // in any initialization code
minViewFrom            // being assigned to viewFrom
maxViewTo              // being assigned to viewTo
```

### "Panning doesn't work at all"

Check that you kept the actual pan calculation:
```typescript
// This line MUST exist in your pan handler:
const proposedFrom = this.viewFrom - deltaTime;  // or similar
const proposedTo = this.viewTo - deltaTime;      // or similar
```

### "Can scroll infinitely (no boundaries)"

Check that:
1. `getDataExtent()` returns valid data
2. `calculateScrollBounds()` returns non-null
3. `clampToBounds()` is actually being called
4. The result of `clampToBounds()` is being used

Add this debug logging:
```typescript
console.log('Pan Debug:', {
  extent: this.getDataExtent(),
  bounds: calculateScrollBounds(extent, proposedTo - proposedFrom),
  proposed: { from: proposedFrom, to: proposedTo },
  result: result,
});
```
