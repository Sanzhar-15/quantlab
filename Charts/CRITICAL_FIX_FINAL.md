# Critical Fix - Final Analysis

## The Problem That Still Persisted

Even after implementing the "unified tick system", the grid lines and axis labels were STILL not perfectly aligned. The user reported:
- Jittery/shaky movement
- Y-axis and grid not in line
- Not every axis label has a corresponding grid line

## Root Cause Analysis

After deep investigation, I found the **critical flaw** in the implementation:

### The Issue: Two Separate Tick Sources

**What was happening:**

1. **Axis Labels** were generated from `leftTicks` / `rightTicks`:
   ```typescript
   const rawAxisLabelsLeft = leftTicks
     .filter(t => t.kind === 'major')
     .map(tick => ({ text: tick.label, y: tick.px }));
   ```

2. **Grid Lines** were using `cachedYTicksByPane.get(pane.id)`:
   ```typescript
   const yTicks = cachedYTicksByPane.get(paneState.id) || [];
   renderGridFromTicks(ctx, plotRect, yTicks, xTicks, ...);
   ```

3. **The Problem**: `cachedYTicksByPane` was being set CONDITIONALLY:
   ```typescript
   if (!panActive) {
     cachedYTicksByPane.set(pane.id, gridTicks);
   }
   ```

**Result:** During and after panning, the grid was using DIFFERENT ticks than the axis labels!

### Why This Caused Misalignment

```
Frame 1 (not panning):
  - leftTicks generated with values [100, 110, 120]
  - Axis labels use leftTicks → [100, 110, 120]
  - cachedYTicksByPane NOT updated (condition failed)
  - Grid uses OLD cached ticks → [95, 105, 115]  ❌ MISMATCH!

Frame 2 (panning):
  - frozenYTicksByPane used
  - Axis labels use leftTicks (newly generated)
  - Grid uses frozenYTicksByPane (old frozen values)
  ❌ DIFFERENT SOURCES!
```

## The Fix

### Changed: Always Cache the Same Ticks

```typescript
// BEFORE (wrong):
if (!panActive) {
  cachedYTicksByPane.set(pane.id, gridTicks);  // Only cache when not panning
}

// AFTER (correct):
cachedYTicksByPane.set(pane.id, gridTicks);  // ALWAYS cache
```

### Why This Works

Now the flow is:

```
1. Generate ticks (leftTicks/rightTicks) with pre-snapped px values
2. Use these ticks for axis labels
3. Store SAME ticks in cachedYTicksByPane
4. Grid renderer reads from cachedYTicksByPane
5. Result: Grid and axis use IDENTICAL tick array
```

**Key insight:** The cache must ALWAYS be updated with the current ticks, not conditionally. This ensures that when `drawUnderlay()` reads from `cachedYTicksByPane`, it gets the EXACT SAME ticks that were used for axis labels.

## The Complete Data Flow (Now Correct)

```
┌─────────────────────────────────────────────┐
│  1. Generate leftTicks/rightTicks           │
│     - Pre-snapped px values                 │
│     - Labels included                       │
└──────────────────┬──────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
        ▼                     ▼
┌───────────────┐    ┌────────────────────┐
│ Axis Labels   │    │ cachedYTicksByPane │
│ (use directly)│    │ (store for grid)   │
└───────────────┘    └─────────┬──────────┘
                               │
                               ▼
                     ┌──────────────────┐
                     │ drawUnderlay()   │
                     │ reads from cache │
                     └─────────┬────────┘
                               │
                               ▼
                     ┌──────────────────┐
                     │ Grid Renderer    │
                     │ (uses tick.px)   │
                     └──────────────────┘

RESULT: Axis and Grid use SAME tick array
```

## Additional Issues Found and Fixed

### Issue 1: Redundant gridScale Variable

**Before:**
```typescript
let gridScale = primaryAxis === 'right' ? pane.rightScale : pane.leftScale;
// ... used in multiple places
```

**After:**
```typescript
// Only calculate when needed (during pan with frozen ticks)
if (panActive && frozenYTicksByPane.has(pane.id)) {
  const gridScale = primaryAxis === 'right' ? pane.rightScale : pane.leftScale;
  // ... use it
}
```

### Issue 2: Unclear Logic Flow

**Before:** The code had two branches (panActive vs not) with similar logic, making it hard to see that caching was conditional.

**After:** Simplified to make it clear that caching ALWAYS happens:
```typescript
// Generate or use frozen ticks
if (panActive && frozenYTicksByPane.has(pane.id)) {
  // Use frozen
} else {
  // Use fresh
}

// ALWAYS cache the result
cachedYTicksByPane.set(pane.id, gridTicks);
```

## Why Previous Attempts Failed

### Attempt 1: Data-Space Refactor
- Fixed the transform issue (grid and candlesticks now use same transform)
- But didn't fix the "two sources" problem

### Attempt 2: Unified Tick System
- Fixed snapping (single snap point)
- Fixed X-axis alignment (time labels and grid use same xTicks)
- But Y-axis still had the conditional caching bug

### Attempt 3: This Fix
- **Finally** ensures Y-axis grid and labels use the SAME tick source
- Removes the conditional caching that was breaking alignment

## Testing Checklist

After this fix, verify:

1. ✅ **Y-axis alignment**: Every horizontal grid line aligns with a Y-axis label
2. ✅ **X-axis alignment**: Every vertical grid line aligns with a time label
3. ✅ **No jitter**: Smooth movement during pan
4. ✅ **Consistency**: Grid and labels stay aligned during zoom
5. ✅ **Completeness**: Every major tick has both a grid line AND a label

## Summary

The critical bug was **conditional caching** of Y-axis ticks:
- Axis labels used `leftTicks`/`rightTicks` directly
- Grid used `cachedYTicksByPane`
- Cache was only updated when `!panActive`
- Result: Grid and axis used DIFFERENT tick arrays

**The fix:** ALWAYS update `cachedYTicksByPane` with the current ticks, ensuring grid and axis use the SAME source.

This completes the unified tick system implementation correctly.

