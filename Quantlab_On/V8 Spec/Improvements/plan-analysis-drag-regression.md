# Analysis of Chart Drag Instability Plan (2026-01-25)

**Reviewer:** Claude Opus 4.5
**Plan Under Review:** `plan-2026-01-25-graph-drag-taskbar.md`

---

## Executive Summary

The plan demonstrates reasonable diagnostic methodology but **misses the most likely root cause** and proposes overly broad investigation steps. After in-depth codebase analysis, I've identified a more probable explanation for the "zooms out to one point" behavior.

---

## Issue #1: Chart Drag Instability - Analysis

### User's Symptoms (Critical Context)
1. **"When I drag it zooms out the graph to one point"** - Series collapses to single X coordinate
2. **"Only the grid moves"** - Grid renders correctly during pan
3. **"Resets after dragging the axes"** - Axis drag somehow restores normal state

### Plan's Hypotheses Assessment

| Hypothesis | Plan's Theory | My Assessment |
|------------|---------------|---------------|
| **1. forceCoherentFrames** | May cause stale series cache | **UNLIKELY** - `forceCoherentFrames` just forces all layers to render; it doesn't modify ranges |
| **2. Plugin transform change (panOffset)** | Other parts may assume raw xScale | **PARTIALLY CORRECT** - But the issue is more specific |
| **3. Pan-layer/series-layer interaction** | Cache invalidation timing off | **IRRELEVANT** - Pan cache is DISABLED (`panOverscanRatio = 0`) |
| **4. Frame budget starving series** | Marker rendering uses too much budget | **UNLIKELY** - Series rendering is marked 'standard' priority, not 'optional' |

### Missing Root Cause Analysis

The plan **doesn't identify** the actual likely cause:

**The `panOffset` addition to `buildPluginState()` creates an inconsistency:**

```typescript
// File: index.ts:3329-3337
const panOffset = panOverscrollPx;
return {
  visibleRange: xScale.getVisibleRange(),  // NOT adjusted for panOffset
  panOffset,
  timeToX: (time: number) => plotRect.x + xScale.timeToX(time) + panOffset,  // INCLUDES panOffset
  xToTime: (x: number) => xScale.xToTime(x - plotRect.x - panOffset) as TimeMs,  // INCLUDES panOffset
  // ...
};
```

**The Problem:**
- `visibleRange` is the raw scale range (no pan offset compensation)
- `timeToX/xToTime` apply `panOffset` translation
- This creates a **coordinate space mismatch** for plugins (drawing objects)

**But this doesn't explain the "zoom to point" symptom.**

### More Likely Root Cause: Range Corruption During Pan

The symptom "zooms out to one point" suggests the visible range (`range.from`, `range.to`) is becoming **collapsed or invalid**. Looking at the code:

```typescript
// File: index.ts:7279-7281
const timeSpan = range.to - range.from;
const timeScaleX = timeSpan > 0 ? plotRect.width / timeSpan : 0;
const timeOriginX = plotRect.x - range.from * timeScaleX + xOffset;
```

If `timeSpan` becomes 0 or near-zero:
- `timeScaleX` becomes 0
- All candles render at `timeOriginX = plotRect.x + xOffset`
- This is the "single point" behavior!

**Question to Investigate:** What recent change could cause `range.from` to equal or approach `range.to` during pan?

### Potential Causes Not Covered in Plan

1. **xScale state corruption during pan** - If `xScale.setVisibleRange()` or `xScale.panByPixels()` has a bug that collapses the range

2. **Double pan offset application** - If `panOverscrollPx` is being applied twice somewhere

3. **Incorrect range calculation when panOffset is non-zero** - The grid uses `panOffsetPx` but series might be using a different calculation

4. **State not being reset properly** - Pan state variables might persist incorrectly

---

## Plan's Diagnostic Steps - Assessment

### What's Good

- **Step A (Reproduce + Capture):** Logging `visibleRange`, `panOverscrollPx`, and `renderQualityLevel` is useful
- **Step B (Likely Regression Sources):** Identifies reasonable candidates (though misses the main one)
- **Step C (Isolation Steps):** Good scientific approach of disabling one thing at a time

### What's Missing

1. **Log the actual range values** - Need to log `range.from`, `range.to`, and `timeSpan` during series rendering to confirm range collapse

2. **Check xScale state** - Log `xScale.getVisibleRange()` at multiple points to see where corruption happens

3. **Compare pan vs axis drag** - The fact that axis drag "resets" the issue suggests axis drag restores some state that pan corrupts

4. **Git bisect** - Find exactly which commit introduced the regression

---

## Revised Investigation Plan

### Step 1: Confirm Range Collapse (HIGH PRIORITY)
Add temporary logging in `renderSeriesToContext` (line 7279):
```typescript
const timeSpan = range.to - range.from;
console.log('[DIAG] Series render range:', { from: range.from, to: range.to, span: timeSpan });
if (timeSpan <= 0) {
  console.error('[BUG] Range collapsed!');
}
```

### Step 2: Trace Range Through Pan
Add logging in:
- `applyPan()` (line 4540) - before and after `xScale.panByPixels()`
- `renderSeries()` (line 8091) - when `range` is read
- Compare values between grid rendering and series rendering

### Step 3: Check Pan vs Axis Drag Difference
Compare what state changes between:
- `endPan()` (line 4351) - called when pan ends
- `updateAxisDrag()` (line 9629) - called during axis drag
- What does axis drag reset that pan doesn't?

### Step 4: Review Recent panOffset Changes
Check git history for changes to `buildPluginState()` - specifically the addition of `panOffset` to `timeToX/xToTime`.

---

## Issue #2: Taskbar Icon - Assessment

### Plan's Approach
The plan correctly identifies:
- Check `.desktop` file exists and has correct paths
- Verify icon file exists
- Refresh desktop database

### Assessment: **ADEQUATE**
The taskbar icon approach is straightforward and appropriate. The steps are:
1. Verify `~/.local/share/applications/quantlab-dev.desktop` exists
2. Check `Icon=` path points to valid PNG
3. Run `update-desktop-database`

No significant changes needed for this section.

---

## Overall Plan Quality

| Aspect | Rating | Notes |
|--------|--------|-------|
| **Diagnostic approach** | 6/10 | Good structure but misses likely root cause |
| **Root cause analysis** | 4/10 | Hypotheses are reasonable but don't match symptoms |
| **Fix strategy** | 5/10 | Too broad; needs more targeted investigation |
| **Completeness** | 5/10 | Missing key logging points and state comparisons |
| **Taskbar section** | 8/10 | Adequate for the simpler problem |

---

## Recommended Additions to Plan

### For Chart Drag Issue

1. **Add range validation logging** - Most critical to confirm the "zoom to point" is caused by range collapse

2. **Add guard rails** - In `renderSeriesToContext`, add:
   ```typescript
   if (range.to - range.from <= 0) {
     console.warn('Invalid range, skipping series render');
     return;
   }
   ```

3. **Check for recent changes to:**
   - `xScale.panByPixels()`
   - `buildPluginState()` panOffset addition
   - Any pan handling code

4. **Compare behavior with/without panOffset** - Temporarily remove `+ panOffset` from `timeToX` to see if that's the cause

### Root Cause Priority Order

1. **MOST LIKELY:** Range calculation bug introduced by recent changes
2. **POSSIBLE:** panOffset creating coordinate space inconsistency
3. **UNLIKELY:** forceCoherentFrames or frame budget issues

---

## Conclusion

The plan provides a reasonable starting framework but **underweights the importance of logging actual range values** and **overweights unlikely causes** like frame budget and coherent frames.

The "zooms to one point" symptom is very specific and almost certainly indicates a **range collapse bug** where `range.from ≈ range.to`. Finding where this corruption happens should be the first priority.

I recommend augmenting the plan with explicit range logging and validation before investigating the broader hypotheses.
