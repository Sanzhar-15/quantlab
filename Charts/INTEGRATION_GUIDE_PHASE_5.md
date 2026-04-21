# Phase 5: Main Renderer Integration Guide

**Status**: Foundation Complete ✅ | Integration Ready ⏳  
**File**: `packages/chart-render-canvas2d/src/index.ts`  
**Risk Level**: Medium (requires careful surgical changes)

---

## Prerequisites Complete ✅

All foundation work is done:
- ✅ Imports added (`Tick`, `GridOptions`, `renderGridFromTicks`, `GridTransitionManager`)
- ✅ State variables added (lines ~1260-1275)
- ✅ All new modules compile without errors
- ✅ TypeScript validation passed

---

## Integration Points

### 1. Y-Axis Tick Generation (2 locations)

**Location 1**: Line ~6135 (Axis Width Measurement Pass)  
**Location 2**: Line ~6497 (Rendering Pass)

**Current Code**:
```typescript
const leftTicks = axisUsage.left ? pane.leftScale.getTicks() : [];
const rightTicks = axisUsage.right ? pane.rightScale.getTicks() : [];
```

**Replace With**:
```typescript
// Unified tick system: Generate Tick[] arrays
const leftTicks: Tick[] = axisUsage.left && useUnifiedTickSystem
  ? pane.leftScale.generateTicks(
      (v) => underlay.snapY(paneRect.y + pane.leftScale.valueToY(v)),
      {
        targetMajorPx: 80,
        minMajorPx: 50,
        maxMajorPx: 120,
        showMinors: !skipMinorGrid,
        minMinorPx: 12,
        tickSize: leftOptions.priceFormat?.minMove ?? 0,
        useFinancialNice: true,
      }
    )
  : (axisUsage.left ? pane.leftScale.getTicks().map((v): Tick => ({
      value: v,
      px: underlay.snapY(paneRect.y + pane.leftScale.valueToY(v)),
      kind: 'major',
      label: pane.leftScale.format(v),
    })) : []);

const rightTicks: Tick[] = axisUsage.right && useUnifiedTickSystem
  ? pane.rightScale.generateTicks(
      (v) => underlay.snapY(paneRect.y + pane.rightScale.valueToY(v)),
      {
        targetMajorPx: 80,
        minMajorPx: 50,
        maxMajorPx: 120,
        showMinors: !skipMinorGrid,
        minMinorPx: 12,
        tickSize: rightOptions.priceFormat?.minMove ?? 0,
        useFinancialNice: true,
      }
    )
  : (axisUsage.right ? pane.rightScale.getTicks().map((v): Tick => ({
      value: v,
      px: underlay.snapY(paneRect.y + pane.rightScale.valueToY(v)),
      kind: 'major',
      label: pane.rightScale.format(v),
    })) : []);
```

**Why Two Locations**: The first pass measures axis widths, the second prepares for rendering.

---

### 2. Fix Axis Label Generation

**Current Code** (lines ~6138-6154, ~6500-6516):
```typescript
const leftMaxWidth = leftTicksVisible
  ? leftTicks.reduce((max, tick) => {
      const text = pane.leftScale.format(tick);  // ← tick is now Tick, not number
      ...
    }, 0)
  : 0;
```

**Replace With**:
```typescript
const leftMaxWidth = leftTicksVisible
  ? leftTicks
      .filter(t => t.kind === 'major' || t.kind === 'edge')
      .reduce((max, tick) => {
        const text = tick.label ?? pane.leftScale.format(tick.value);
        if (canReuseAxisWidthLeft) {
          return Math.max(max, cachedLeftLabelWidth);
        }
        return Math.max(max, measureLabel(text));
      }, 0)
  : 0;
```

**Do the same for `rightMaxWidth`**.

---

### 3. Fix Raw Axis Labels

**Current Code** (lines ~6158-6171, ~6520-6533):
```typescript
const rawAxisLabelsLeft = paneLayout.leftAxisRect && leftTicksVisible
  ? leftTicks.map((tick) => ({
      text: pane.leftScale.format(tick),
      y: underlay.snapY(paneRect.y + pane.leftScale.valueToY(tick)),
      width: leftMaxWidth,
    }))
  : [];
```

**Replace With**:
```typescript
const rawAxisLabelsLeft = paneLayout.leftAxisRect && leftTicksVisible
  ? leftTicks
      .filter(t => (t.kind === 'major' || t.kind === 'edge') && t.label)
      .map((tick) => ({
        text: tick.label!,
        y: tick.px,  // Already snapped!
        width: leftMaxWidth,
      }))
  : [];
```

**Do the same for `rawAxisLabelsRight`**.

---

### 4. X-Axis Tick Generation

**Location**: Line ~6397-6448

**Current Code**:
```typescript
const xTickCount = clamp(...);
let gridX: number[] = [];
let tickTimes: number[];

// Complex caching logic...
tickTimes = xScale.getTicksForRange(resolvedRange, xTickCount);
```

**Replace With**:
```typescript
const xTickCount = clamp(...);

// Unified tick system: Generate X-axis Tick[]
const xTicks: Tick[] = useUnifiedTickSystem
  ? xScale.generateTicks(
      (time) => underlay.snapX(plotRect.x + xScale.timeToX(time)),
      resolvedRange,
      xTickCount
    )
  : xScale.getTicksForRange(resolvedRange, xTickCount).map((time): Tick => ({
      value: time,
      px: underlay.snapX(plotRect.x + xScale.timeToX(time)),
      kind: 'major',
      label: formatTime(time),
    }));

// Extract positions for backward compatibility
const gridX = xTicks.filter(t => t.kind === 'major' || t.kind === 'edge').map(t => t.px);
```

---

### 5. Fix Time Labels

**Current Code** (lines ~6426-6448):
```typescript
const rawTimeLabels: TimeLabel[] = [];

if (!panActive) {
  for (let i = 0; i < Math.min(gridX.length, tickTimes.length); i++) {
    rawTimeLabels.push({
      text: formatTime(tickTimes[i]!),
      x: underlay.snapX(gridX[i]!),
      width: maxTimeLabelWidth,
    });
  }
  cachedTimeLabels = rawTimeLabels;
} else {
  // Reuse cached labels...
}
```

**Replace With**:
```typescript
const rawTimeLabels: TimeLabel[] = panActive && cachedTimeLabels.length > 0
  ? cachedTimeLabels  // Reuse during pan
  : xTicks
      .filter(t => t.label)
      .map(t => ({
        text: t.label!,
        x: t.px,
        width: maxTimeLabelWidth,
      }));

if (!panActive) {
  cachedTimeLabels = rawTimeLabels;
}
```

---

### 6. Tick Caching During Pan

**Location**: Lines ~6547-6592 (Y-axis grid generation)

**Current Code**:
```typescript
let gridTicks: number[];
let gridY: number[];
let gridScale = primaryAxis === 'right' ? pane.rightScale : pane.leftScale;

if (panActive && cachedPaneGridPriceStruct.has(pane.id)) {
  const cached = cachedPaneGridPriceStruct.get(pane.id)!;
  if (Math.abs(cached.plotHeight - paneRect.height) < 1) {
    gridTicks = cached.tickPrices;
    gridY = cached.gridY;
  } else {
    // Regenerate...
  }
} else {
  // Generate fresh...
}
```

**Replace With**:
```typescript
// Get ticks for primary axis (already generated above)
const primaryTicks = primaryAxis === 'right' ? rightTicks : leftTicks;

// Cache during pan: only update pixel positions
if (panActive && cachedYTicksByPane.has(pane.id)) {
  const cached = cachedYTicksByPane.get(pane.id)!;
  if (Math.abs((cached[0]?.px ?? 0) - paneRect.y) < 1000) { // Same pane position roughly
    // Update pixel positions only
    cached.forEach((tick: Tick) => {
      tick.px = underlay.snapY(paneRect.y + gridScale.valueToY(tick.value));
    });
    yTicks = cached;
  } else {
    // Layout changed, use fresh ticks
    cachedYTicksByPane.set(pane.id, [...primaryTicks]);
  }
} else {
  // First time, cache it
  cachedYTicksByPane.set(pane.id, [...primaryTicks]);
}

// Store for this pane
const yTicks = primaryTicks;
```

---

### 7. Grid Rendering with Cross-Fade

**Location**: Line ~6602 (drawUnderlay call)

**Current Code**:
```typescript
drawUnderlay(plotRect, paneStates, gridXMajor, gridXMinorSnapped, skipMinorGrid, xMinorAlpha);
```

**Find `drawUnderlay` function** and modify it to use unified system:

**Add at start of drawUnderlay**:
```typescript
// Initialize transition manager if needed
if (!gridTransitionManager && useUnifiedTickSystem) {
  gridTransitionManager = new GridTransitionManager();
}
```

**Replace grid rendering** (inside pane loop):
```typescript
if (useUnifiedTickSystem) {
  // Get Y ticks for this pane
  const paneState = paneStates.find(p => p.id === pane.id);
  if (!paneState) continue;
  
  const yTicks = primaryAxis === 'right' ? rightTicks : leftTicks;
  
  // Grid style configuration
  const gridStyle = {
    majorColor: paint.gridMajor,
    minorColor: paint.gridMinor,
    majorAlpha: 0.8,
    minorAlpha: skipMinorGrid ? 0 : 0.65,
    dpr: underlay.getSize().dpr,
    fadeMinors: true,
  };
  
  // Try cross-fade transition first
  const didTransition = gridTransitionManager.renderWithTransition(
    ctx,
    paneRect,
    yTicks,
    xTicks,  // Use unified X ticks
    gridStyle
  );
  
  // If no transition, render normally
  if (!didTransition) {
    renderGridFromTicks(
      ctx,
      paneRect,
      yTicks,
      xTicks,
      paint.gridMajor,
      paint.gridMinor,
      gridStyle
    );
  }
} else {
  // Old system (fallback)
  renderGrid(ctx, paneRect, gridXMajor, gridYMajor, gridXMinor, gridYMinor, ...);
}
```

---

### 8. GridOptions Configuration

**Add to Chart API** (around line ~10100):

```typescript
// Grid configuration API
const gridOptions: GridOptions = {
  majorColor: paint.gridMajor,
  majorOpacity: 0.8,
  minorColor: paint.gridMinor,
  minorOpacity: 0.65,
  lineWidth: 1,
  targetMajorPx: 80,
  minMajorPx: 50,
  maxMajorPx: 120,
  showMinors: true,
  minMinorPx: 12,
  enableCrossFade: true,
  crossFadeDuration: 120,
  useFinancialNice: true,
  showEdgeTicks: false,
  ...options.grid,
};

// Add methods to returned Chart object
const chart: Chart = {
  // ... existing methods
  
  setGridOptions(opts: Partial<GridOptions>): void {
    Object.assign(gridOptions, opts);
    invalidate(InvalidationFlag.Underlay);
  },
  
  getGridOptions(): GridOptions {
    return { ...gridOptions };
  },
  
  // ... rest of methods
};
```

---

## Testing After Integration

### 1. Build Test
```bash
cd /home/s/Desktop/Charts+/Advanced
npm run build -w @charts-plus/chart-render-canvas2d
```

### 2. Visual Test
- Start demo: `npm run dev -w demo`
- Check: Grid lines align perfectly with axis labels
- Check: Smooth zoom with no jitter
- Check: Grid uses nice numbers (1, 2, 5, 10, 20, 50, 100)
- Check: Minor lines fade smoothly
- Check: Cross-fade when step changes

### 3. Performance Test
- Profile with DevTools
- Pan 60fps maintained
- Zoom 60fps maintained
- No dropped frames

---

## Rollback Strategy

If issues arise:
```typescript
// At top of createChart():
let useUnifiedTickSystem = false; // ← Set to false
```

All code gracefully falls back to old system.

---

## Completion Checklist

- [ ] Y-axis tick generation replaced (2 locations)
- [ ] Axis label generation fixed (2 locations)
- [ ] X-axis tick generation replaced
- [ ] Time labels fixed
- [ ] Tick caching implemented
- [ ] Grid rendering replaced
- [ ] Cross-fade integrated
- [ ] GridOptions API added
- [ ] Build successful
- [ ] Visual validation passed
- [ ] Performance validation passed

---

## Status

**Current**: Foundation complete, integration points documented  
**Next**: Manual integration following this guide  
**Time Estimate**: 2-3 hours for careful implementation  
**Risk**: Medium (complex file, multiple touch points)

---

## Alternative: Automated Integration

If you want me to complete the automated integration, I can proceed but it will require:
1. Multiple careful search-replace operations
2. Thorough testing at each step
3. Risk of breaking existing functionality temporarily

**Recommendation**: Follow this guide manually for maximum safety, OR proceed with automated integration with close monitoring.

