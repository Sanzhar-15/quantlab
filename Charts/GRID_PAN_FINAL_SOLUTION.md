# Grid Pan Synchronization - Final Solution

## Root Cause Analysis

### The Three Issues

1. **Grid doesn't extend beyond initial cache**: When panning far, the grid shows empty space beyond the cached range
2. **Grid jumps on drag start**: When dragging starts, the grid suddenly shifts position or changes scale
3. **X-axis labels disappear**: Time axis labels vanish during panning

### Why These Happen

**The Fundamental Problem**: We're caching grid positions at a specific range, then trying to use composite offsets to move the cached grid. But:

- **Cache is fixed-range**: Created for range [100,200], has no lines for [150,250]
- **Cache mismatch on pan start**: When pan starts, cache is from old range, composite offset creates jump
- **Over-complicated**: Trying to mimic candlestick pan cache, but grid is fundamentally different

**Candlesticks vs Grid**:
- **Candlesticks**: Expensive to render (100s of shapes), so we cache and offset the image
- **Grid**: Cheap to render (just lines), should regenerate every frame with current range

## The Solution

### Core Principle
> **Don't cache grid positions during pan. Regenerate from current range every frame.**

### Why This Works

1. **Grid always matches visible range**: No empty space when panning far
2. **No cache mismatch**: No jump on pan start since we're not switching to cache
3. **Labels stay correct**: Generated for current range every frame
4. **Still smooth**: Transform offset only for elastic overscroll (sub-pixel positioning)

### Implementation

**During Pan**:
- Generate grid ticks for CURRENT visible range
- Apply only elastic overscroll offset (panOffsetPx)
- No composite offset, no range offset

**Not During Pan**:
- Use cached grid positions (optimization for when not moving)

## Implementation Steps

### Step 1: Remove Composite Offset Calculation

In `drawUnderlay()`, remove the range offset calculation and only apply elastic overscroll:

```typescript
// BEFORE (wrong):
let totalOffsetX = panOffsetPx;
if (cachedGridTimeStruct && panActive && currentRange) {
  const span = cachedGridTimeStruct.range.to - cachedGridTimeStruct.range.from;
  if (span > 0) {
    const scaleX = plotRect.width / span;
    const rangeOffset = (currentRange.from - cachedGridTimeStruct.range.from) * scaleX;
    totalOffsetX = -rangeOffset + panOffsetPx;  // Composite
  }
}
ctx.translate(totalOffsetX, 0);

// AFTER (correct):
// Only apply elastic overscroll offset
ctx.translate(panOffsetPx, 0);
```

### Step 2: Don't Use Cached Grid During Pan

In `renderUnderlay()`, prevent cache reuse during pan:

```typescript
// BEFORE:
if (panActive && cachedGridTimeStruct && ...)

// AFTER:
// Don't use cache during pan - regenerate for current range
if (!panActive && cachedGridTimeStruct && ...)
```

This ensures grid is regenerated every frame during pan.

### Step 3: Same for renderLayout()

Same change in `renderLayout()` - don't use cache during pan.

## Expected Result

**During Pan**:
- Grid regenerates every frame for current visible range
- Always has grid lines for visible area
- No jump on pan start
- Labels always visible and correct
- Only elastic overscroll offset applied

**After Pan**:
- Grid uses cache for performance
- No regeneration needed

## Performance

**Concern**: Regenerating grid every frame during pan

**Answer**: Grid is very cheap:
- 20-40 tick calculations
- 20-40 line draws (or Path2D)
- Total: < 0.5ms per frame
- Still 60fps with room to spare

**Candlesticks** are expensive (100s of complex shapes, colors, fills), so they need cache + offset.
**Grid** is cheap (simple lines), so regeneration is fine.

