# LLM 1 Plan: Fix Chart Drag Bug - Deep Analysis

**Date**: 2026-01-26
**Status**: Investigation Required

---

## Updated Symptom Analysis

Based on testing, the actual behavior is:
1. **At drag START**: Sudden "zoom out" - candlesticks appear on LEFT half, empty future on RIGHT half
2. **During drag**: Grid moves correctly, but candlesticks barely move
3. **After dragging axes**: Everything resets to normal

This suggests:
- The visible range is being DOUBLED at pan start (explaining the zoom out with data on left, empty on right)
- The pan cache offset calculation doesn't match the grid's movement

---

## Root Cause Analysis

### Key Code Paths

**File**: `/home/steppen0mad/Desktop/quantlab/quantlab/Charts/packages/chart-render-canvas2d/src/index.ts`

### 1. Pan Cache Creation (lines 8226-8228)
```typescript
const cache =
  canUsePanCache(paneState.id, axis, range, paneState.plotRect, axisScalePayload) ??
  buildPanCache(paneState.id, axis, cacheBaseRange, paneState.plotRect, axisSeries, axisScalePayload);
```
- Cache is checked with `range` (current visible)
- Cache is BUILT with `cacheBaseRange` (frozen at pan start)

### 2. buildPanCache (lines 7791-7856)
```typescript
const cacheRange = buildPanOverscanRange(range);  // Creates wider range
const cacheWidth = plotRect.width + overscanPx * 2;  // Wider canvas
renderSeriesToContext(ctx, ..., cachePlotRect, cacheRange, ...);  // Renders with overscan range
```
- Cache canvas is WIDER than visible area
- Cache time range is WIDER than visible range
- Series rendered at scale: `cacheWidth / cacheRangeSpan`

### 3. drawPanCache (lines 7936-7995)
```typescript
const scaleX = cache.width / cacheSpan;  // Cache's internal scale
const offset = (range.from - cache.range.from) * scaleX;  // Pixels from cache start
const drawX = plotRect.x - offset + xOffset;  // Where to draw
```

### 4. Grid Rendering (lines 6462-6463)
```typescript
const gridXTicks = panOffsetPx !== 0
  ? xTicks.map((tick) => ({ ...tick, px: tick.px + panOffsetPx }))
  : xTicks;
```
- Grid ticks are **regenerated each frame** based on current visible range
- Only applies `panOffsetPx` during OVERSCROLL (elastic bounce)
- During normal pan, ticks use the updated visible range directly

---

## The Core Mismatch

**Grid**: Uses current visible range each frame → moves correctly
**Pan Cache**: Uses frozen `cacheBaseRange` with calculated offset → may not match

The cache offset calculation:
- `offset = (range.from - cache.range.from) * scaleX`
- `scaleX = cache.width / cacheSpan` (cache's scale, NOT visible scale)

When range changes by Δ units:
- Grid shift: `Δ * (plotRect.width / visibleSpan)` pixels
- Cache shift: `Δ * (cacheWidth / cacheSpan)` pixels

These are DIFFERENT because cache uses a wider range/width!

**However**, the ratio should be preserved mathematically:
- `cacheWidth / cacheSpan = (plotWidth + 2*overscan) / (span + 2*span*ratio)`
- If overscanRatio = 1: `(plotWidth + 2*plotWidth) / (span + 2*span) = 3*plotWidth / 3*span = plotWidth/span`

So mathematically they should match. The bug must be elsewhere.

---

## Likely Cause: cacheBaseRange Issue

At line 8126-8137:
```typescript
let cacheBaseRange = elasticPan ? elasticRange : range;
if (panActive) {
  if (!panBaseRange) {
    panBaseRange = cacheBaseRange;
  } else {
    const overscanRange = buildPanOverscanRange(panBaseRange);
    if (!rangeContains(overscanRange, range)) {
      panBaseRange = cacheBaseRange;
      invalidatePanCache();
    }
  }
  cacheBaseRange = panBaseRange ?? cacheBaseRange;
}
```

**Problem**: `cacheBaseRange` is set to `panBaseRange`, but `panBaseRange` is set in `beginPan()` which runs BEFORE `applyPanDelta()`. So on the first pan frame:
- `panBaseRange` = old visible range
- `range` = new visible range (after pan delta applied)
- Cache is built with `panBaseRange` (old range)
- Cache is drawn with offset based on `range` (new range)

This should work... unless `panBaseRange` is being set incorrectly.

---

## Fix Strategy

### Step 1: Add Comprehensive Diagnostics

Add logging to trace exactly what happens at pan start:

**Location 1**: `beginPan()` (line 4326)
```typescript
const beginPan = (): void => {
  if (panActive) return;
  panActive = true;
  // ... existing code ...
  const { clamped } = resolveElasticRange(xScale.getVisibleRange());
  panBaseRange = clamped;
  console.log('[PAN] beginPan:', {
    panBaseRange: { from: panBaseRange.from, to: panBaseRange.to },
    span: panBaseRange.to - panBaseRange.from,
  });
};
```

**Location 2**: `renderSeries()` (after line 8102)
```typescript
const range = xScale.getVisibleRange();
console.log('[PAN] renderSeries:', {
  panActive,
  range: { from: range.from, to: range.to },
  panBaseRange: panBaseRange ? { from: panBaseRange.from, to: panBaseRange.to } : null,
  rangeSpan: range.to - range.from,
  panBaseSpan: panBaseRange ? panBaseRange.to - panBaseRange.from : null,
});
```

**Location 3**: `drawPanCache()` (after line 7954)
```typescript
console.log('[PAN] drawPanCache:', {
  cacheRange: { from: cache.range.from, to: cache.range.to },
  visibleRange: { from: range.from, to: range.to },
  offset,
  drawX,
  scaleX,
});
```

### Step 2: Verify Grid vs Series Alignment

Add logging to compare grid tick positions with expected series X positions.

### Step 3: Fix Based on Diagnostics

Most likely fixes:

**Fix A**: Ensure cache is rebuilt when range doesn't match
```typescript
// In canUsePanCache, add stricter validation
const rangeScale = plotRect.width / (range.to - range.from);
const cacheScale = cache.width / (cache.range.to - cache.range.from);
if (Math.abs(rangeScale - cacheScale) > 0.001) {
  return null; // Force rebuild
}
```

**Fix B**: Pass visible range info to drawPanCache for consistent offset
```typescript
// In drawPanCache, use visible range scale for offset
const visibleSpan = range.to - range.from;
const visibleScale = plotRect.width / visibleSpan;
const offset = (range.from - cache.range.from) * visibleScale * (cache.width / plotRect.width);
```

**Fix C**: Bypass pan cache during debugging
```typescript
// Temporarily disable pan cache to confirm it's the source
const usePanCache = false; // panOverscanRatio > 0 && ...
```

---

## Quick Test: Disable Pan Cache

To confirm pan cache is the issue, temporarily disable it:

```typescript
// Line 8123-8124: Change to
const usePanCache = false; // Temporarily disable
```

If chart works correctly after this, the bug is confirmed to be in pan cache logic.

---

## Taskbar Icon Fix

Already attempted:
- Icon copied to `~/.local/share/icons/hicolor/512x512/apps/quantlab.png`
- Desktop file updated to use `Icon=quantlab`
- Icon cache updated

Still needs:
1. Verify StartupWMClass matches actual window class
2. Log out/in or restart GNOME shell

Run:
```bash
xprop | grep WM_CLASS
# Click on Quantlab window to get actual class
```

---

## Files to Modify

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | 4326-4349 | Add diagnostics to beginPan |
| `index.ts` | 8097-8115 | Add diagnostics to renderSeries |
| `index.ts` | 7936-7995 | Add diagnostics to drawPanCache |
| `index.ts` | 8210-8256 | Review pan cache usage flow |

---

## Verification Steps

1. Open Quantlab with dev tools console open
2. Start dragging the chart
3. Check console for `[PAN]` logs
4. Analyze the range values - look for:
   - Range suddenly doubling
   - cacheBaseRange not matching expected
   - offset calculation inconsistencies
5. Apply fix based on findings
6. Verify: drag should move candlesticks with grid

---

## Priority

| Priority | Issue | Complexity | Risk |
|----------|-------|------------|------|
| 1 | Chart Drag | HIGH | HIGH - Core functionality broken |
| 2 | Taskbar Icon | LOW | LOW - Desktop environment issue |

---

## Next Steps

1. Add diagnostic logging as specified above
2. Run Quantlab and reproduce the bug
3. Analyze console logs to identify exact cause
4. Apply targeted fix based on findings
5. Verify fix resolves the issue
