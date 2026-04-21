# Proposed Revisions to Quantlab Improvements Plan

**Date:** 2026-01-25
**Reviewer:** Claude Opus 4.5
**Original Plan:** `plan-2026-01-25.md`

---

## Executive Summary

After in-depth analysis of the quantlab codebase, I've identified several critical issues with the original plan that could lead to wasted effort or incomplete fixes. This document provides:

1. **Critical corrections** to plan assumptions
2. **Root cause analysis** with exact file paths and line numbers
3. **Optimized implementation approach** for each issue
4. **Alternative/additional solutions** where applicable

---

## Critical Finding #1: Pan Cache is DISABLED (V8 Fix)

**Impact:** Phase 3 (Candlestick Jitter) is based on incorrect assumptions.

**Evidence:**
```typescript
// File: Charts/packages/chart-render-canvas2d/src/index.ts:1446-1452
// V8 Fix: Pan cache disabled to resolve rendering inconsistencies during drag
// The pan cache optimization (pre-rendering with overscan) caused:
// 1. Bar width discrepancies near data boundaries (different point counts)
// 2. Bar position shifts (different pixel alignment between cache and direct rendering)
// Disabling the cache ensures consistent rendering at the cost of slightly higher CPU during pan.
// To re-enable, restore: panOverscanRatio = panOptions.overscanRatio ?? PAN_OVERSCAN_RATIO
const panOverscanRatio = 0;
```

**Implication:** The original plan's Phase 3 focuses on "pan cache activation/deactivation" causing jitter, but **pan cache is already disabled**. The jitter must come from a different source.

---

## Critical Finding #2: Missing Pan Offset in Drawing Plugin State

**Impact:** This is the TRUE root cause of Issue #2 (Entry/Exit levels lag during drag).

**Evidence:**
```typescript
// File: Charts/packages/chart-render-canvas2d/src/index.ts:3312-3318
return {
  // ...
  timeToX: (time: number) => plotRect.x + xScale.timeToX(time),  // NO panOverscrollPx!
  // ...
};

// But series markers DO get the offset:
// File: Charts/packages/chart-render-canvas2d/src/index.ts:8699
renderSeriesMarkers(ctx, panOverscrollPx);
```

The drawing plugin's `timeToX` function in `PluginRenderState` does NOT include `panOverscrollPx`. When rubber-band overscroll is active (elasticPan), the candlesticks shift but drawing objects don't follow.

---

## Critical Finding #3: No Visibility Change Handler Exists

**Impact:** Confirms original plan's hypothesis for Issue #1, but needs more precise implementation.

**Evidence:** Grep for `visibilitychange` shows only documentation files, no actual implementation.

---

## Revised Implementation Plan

### Phase 1: X-Axis Random Hours in Fullscreen/Tab Switch

#### Original Plan Assessment: **Partially Correct**
The hypothesis about tick cache and visibility is correct, but the implementation approach needs refinement.

#### Root Cause Analysis
1. **Primary:** No `document.visibilitychange` listener to invalidate tick cache on tab activation
2. **Secondary:** ResizeObserver fires while `requestAnimationFrame` is paused (hidden tab), causing size/cache mismatch
3. **Tertiary:** TimeScale tick hysteresis state persists across large width changes

#### Revised Implementation

**A. Add Visibility Change Handler** (HIGH PRIORITY)
```typescript
// File: Charts/packages/chart-render-canvas2d/src/index.ts
// Add near initialization (~line 1500)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Force complete recalculation
    tickCoordinator.invalidateAll();
    clearGridCache();
    underlay.clearStabilization();
    seriesLayer.clearStabilization();
    overlay.clearStabilization();
    invalidate(InvalidationFlag.All);
  }
});
```

**B. Add Width Change Detection to TickCoordinator**
```typescript
// File: Charts/packages/chart-render-canvas2d/src/tick-coordinator.ts
// Extend cache key to include width bucket

private lastPlotWidth: number | null = null;
private readonly WIDTH_THRESHOLD = 0.1; // 10% change threshold

getXTicks(...): Tick[] {
  const widthChanged = this.lastPlotWidth !== null &&
    Math.abs(plotRect.width - this.lastPlotWidth) / this.lastPlotWidth > this.WIDTH_THRESHOLD;

  if (widthChanged) {
    this.invalidateAll();
  }
  this.lastPlotWidth = plotRect.width;
  // ... rest of logic
}
```

**C. Ensure Post-Visibility Resize**
```typescript
// File: Charts/packages/chart-render-canvas2d/src/canvas-surface.ts
// In resize handler, verify we're visible before processing

if (document.visibilityState !== 'visible') {
  // Queue resize for when we become visible
  this._pendingResize = { width, height };
  return;
}
```

#### Verification
- Fullscreen toggle (F11) should maintain correct X-axis labels
- Tab switch (Ctrl+Tab away and back) should show correct labels immediately
- No zoom required to fix labels after any visibility change

---

### Phase 2: Entry/Exit Levels Track During Drag

#### Original Plan Assessment: **Incomplete - Missing Root Cause**
The plan correctly identifies that overlay should update live, but misses the actual bug.

#### Root Cause (DEFINITIVE)
**`buildPluginState()` does not pass `panOverscrollPx` to the drawing plugin.**

The drawing plugin receives `timeToX: (time) => plotRect.x + xScale.timeToX(time)` which is correct for static rendering but **ignores the elastic overscroll offset** during drag.

#### Revised Implementation

**A. Pass Pan Offset to Plugin State** (CRITICAL FIX)
```typescript
// File: Charts/packages/chart-render-canvas2d/src/index.ts:3289-3356
// Modify buildPluginState to accept and use panOffset

const buildPluginState = (surface: CanvasSurface, panOffset: number = 0): PluginRenderState | null => {
  // ...existing logic...

  return {
    // ...other properties...
    timeToX: (time: number) => plotRect.x + xScale.timeToX(time) + panOffset,  // ADD panOffset
    // ...other properties...
  };
};
```

**B. Update All buildPluginState Calls**
```typescript
// File: Charts/packages/chart-render-canvas2d/src/index.ts:8682
const overlayState = buildPluginState(overlay, panOverscrollPx);  // Pass offset

// Also update pointer dispatch (line 3360):
const state = buildPluginState(overlay, panOverscrollPx);
```

**C. Extend PluginRenderState Type (Optional Enhancement)**
```typescript
// File: Charts/packages/chart-core/src/api.ts:369
export type PluginRenderState = {
  // ...existing...
  panOffset?: number;  // Expose for plugins that need raw value
};
```

#### Verification
- Drag chart left/right: Entry/Exit levels should follow exactly with candlesticks
- Drag axes (zoom): Levels should scale proportionally in real-time
- Release mouse: No visual "snap" or position jump

---

### Phase 3: Candlestick Jitter at Start/End of Drag

#### Original Plan Assessment: **INCORRECT - Based on Disabled Feature**
The pan cache hypothesis is invalid because **pan cache is disabled** (V8 fix).

#### Root Cause Analysis (Revised)
With pan cache disabled, jitter must come from one of:

1. **Coordinate Stabilizer Mode Switch:** When pan starts/ends, `CoordinateStabilizer` switches between "idle mode" (hysteresis snapping) and "pan mode" (raw floats)
2. **Frame Synchronization:** Inertia/physics calculations may cause slight position oscillation on first/last frames
3. **Invalidation Flag Mismatch:** Series layer invalidation timing differs from pointer state change

#### Revised Investigation Steps

**A. Instrument Coordinate Stabilizer**
```typescript
// File: Charts/packages/chart-render-canvas2d/src/coordinate-stabilizer.ts
// Add logging to track mode switches

clearCache(): void {
  console.log('[CoordStab] Cache cleared - pan start/end transition');
  this._xCache.clear();
  this._yCache.clear();
}
```

**B. Check Physics Initial Velocity**
```typescript
// File: Charts/packages/chart-interaction/src/physics.ts
// Verify velocity isn't jumping on first frame

applyFriction(velocity: number, dt: number): number {
  // If velocity suddenly appears, that's the jitter source
}
```

**C. Proposed Fix: Smooth Stabilizer Transition**
```typescript
// File: Charts/packages/chart-render-canvas2d/src/coordinate-stabilizer.ts
// Don't clear cache immediately - fade out hysteresis over 2-3 frames

private _panTransitionFrames = 0;
private readonly PAN_TRANSITION_DURATION = 3;

setPanActive(active: boolean): void {
  if (active && !this._panActive) {
    this._panTransitionFrames = this.PAN_TRANSITION_DURATION;
  }
  this._panActive = active;
}

snapX(x: number): number {
  if (this._panTransitionFrames > 0) {
    this._panTransitionFrames--;
    // Blend between snapped and raw based on transition progress
    const blend = this._panTransitionFrames / this.PAN_TRANSITION_DURATION;
    const snapped = this._applyHysteresis(x, 'x');
    return x * (1 - blend) + snapped * blend;
  }
  return this._panActive ? x : this._applyHysteresis(x, 'x');
}
```

#### Verification
- Start dragging: First frame should be indistinguishable from subsequent frames
- Release drag: Last dragged position should match static position exactly
- No blinking/jumping of individual candlesticks

---

### Phase 4: Strategy Pane Stability + Toggle Button

#### Original Plan Assessment: **Reasonable but Vague**
The plan lacks specificity about which "strategy pane" is unstable.

#### Clarification
Based on codebase analysis, there are TWO potential "strategy panes":
1. **Chart Indicator Pane:** Multi-pane chart layout with indicator series (managed by chart core)
2. **Parameter Panel:** Bottom panel in chart webview (managed by quantlab extension)

#### Root Causes for Pane Instability

**A. Indicator Pane (Chart Core)**
```typescript
// File: Charts/packages/chart-render-canvas2d/src/index.ts
// Pane visibility depends on series having data

// If indicator series returns empty data, pane may collapse
const paneHasSeries = seriesList.some(s => s.paneId === paneId && s.visible);
if (!paneHasSeries) {
  // Pane becomes hidden - this is the instability
}
```

**B. TabInstanceId Resolution Failure (Extension)**
```typescript
// File: extensions/quantlab/src/views/chart/ChartViewProvider.ts:794-811
// If resolution fails, state becomes undefined
if (!session.tabInstanceId) {
  // State operations won't persist - causes pane to "reset"
}
```

#### Revised Implementation

**A. For Indicator Pane Toggle Button:**
```typescript
// File: extensions/quantlab/webview/chart/index.ts
// Add to toolbar (near line 33-40)

const strategyToggle = document.createElement('button');
strategyToggle.className = 'toolbar-button';
strategyToggle.setAttribute('aria-label', 'Toggle Strategy Pane');
strategyToggle.innerHTML = '<svg>...</svg>'; // Eye icon
strategyToggle.addEventListener('click', () => {
  const hidden = strategyToggle.classList.toggle('pane-hidden');
  vscode.postMessage({ type: 'toggleStrategyPane', hidden });
});
```

**B. Chart API Addition:**
```typescript
// File: Charts/packages/chart-render-canvas2d/src/index.ts
// Add setPaneVisible method

setPaneVisible: (paneId: PaneId, visible: boolean) => {
  const pane = paneStates.get(paneId);
  if (pane) {
    pane.visible = visible;
    if (!visible) {
      storedPaneHeights.set(paneId, pane.height);
    } else {
      pane.height = storedPaneHeights.get(paneId) ?? pane.height;
    }
    invalidate(InvalidationFlag.Layout);
  }
},
```

**C. Persist Visibility State:**
```typescript
// File: extensions/quantlab/src/views/chart/ChartStateStore.ts
interface ChartTabState {
  // ...existing...
  strategyPaneVisible: boolean;  // Add this
}
```

#### Verification
- Toggle button shows/hides indicator pane immediately
- Pane height preserved across hide/show cycles
- State persists across tab switches and editor restarts
- Pane never disappears unexpectedly during normal use

---

### Phase 5: Parameters Bottom Pane Optimization

#### Original Plan Assessment: **Good but Generic**
The suggestions are reasonable but lack codebase-specific implementation details.

#### Current Implementation Analysis
```typescript
// File: extensions/quantlab/webview/chart/parameterPanel.ts
// Current implementation:
// - Creates controls dynamically per parameter
// - No grouping support
// - Inline apply/reset at bottom
// - Fixed height rows but no reserved label widths
```

#### Optimized Implementation

**A. Add Parameter Grouping**
```typescript
// File: extensions/quantlab/src/core/strategy/ParameterExtractor.ts
interface ParameterDefinition {
  // ...existing...
  group?: string;  // Already exists but unused in UI
}

// File: extensions/quantlab/webview/chart/parameterPanel.ts
// Group parameters before rendering
const grouped = parameters.reduce((acc, param) => {
  const group = param.group ?? 'General';
  (acc[group] ??= []).push(param);
  return acc;
}, {} as Record<string, ParameterDefinition[]>);
```

**B. Collapsible Sections**
```html
<!-- Template for collapsible group -->
<details class="param-group" open>
  <summary class="param-group-header">{groupName}</summary>
  <div class="param-group-content">
    <!-- Parameters render here -->
  </div>
</details>
```

**C. Sticky Apply/Reset Footer**
```css
/* File: extensions/quantlab/webview/chart/chart.css */
.params-actions {
  position: sticky;
  bottom: 0;
  background: var(--vscode-panel-background);
  border-top: 1px solid var(--vscode-panel-border);
  padding: 8px;
  z-index: 10;
}
```

**D. Fixed Label Widths (Prevent Layout Shift)**
```css
.param-label {
  display: inline-block;
  min-width: 120px;  /* Prevent jumping when values change */
  text-overflow: ellipsis;
  overflow: hidden;
}

.param-value {
  min-width: 80px;
  text-align: right;
}
```

**E. Debounce Heavy Updates**
```typescript
// File: extensions/quantlab/webview/chart/parameterPanel.ts
// Only trigger chart update on Apply, not on every change

private pendingChanges: Map<string, unknown> = new Map();

onChange(id: string, value: unknown): void {
  this.pendingChanges.set(id, value);
  this.markDirty();
  // DON'T call onApply here
}

onApply(): void {
  this.pendingChanges.forEach((value, id) => {
    this.commitChange(id, value);
  });
  this.pendingChanges.clear();
  this.clearDirty();
}
```

#### Verification
- No layout shift when parameter values update
- Apply button only active when changes are pending
- Reset restores defaults without layout jump
- Grouped parameters are visually distinct and collapsible

---

## Sequencing Revision

| Phase | Priority | Dependency | Risk Level |
|-------|----------|------------|------------|
| 2 (Entry/Exit) | **HIGHEST** | None | Low - Surgical fix |
| 1 (X-Axis) | HIGH | None | Low - Additive change |
| 4 (Strategy Pane) | MEDIUM | None | Medium - UI + API changes |
| 5 (Parameters) | MEDIUM | None | Low - CSS + minor JS |
| 3 (Jitter) | LOW | Investigation first | High - Root cause unclear |

**Rationale:**
- Phase 2 is a definitive bug with a clear 1-line fix
- Phase 1 is clearly understood and low-risk
- Phase 3 needs investigation since pan cache theory is invalid
- Phases 4 & 5 are UX improvements, not blocking bugs

---

## Summary of Key Corrections

| Issue | Original Plan Assumption | Actual Finding |
|-------|-------------------------|----------------|
| Candlestick Jitter | Pan cache activation/deactivation | Pan cache is DISABLED; jitter from coordinate stabilizer mode switch |
| Entry/Exit Lag | Need to ensure overlay invalidation | `buildPluginState()` missing `panOverscrollPx` parameter |
| X-Axis Bug | Tick cache invalidation on visibility | Correct, but no handler exists - needs implementation |
| Strategy Pane | Add pane visibility control | Correct, but need to distinguish indicator pane vs parameter panel |

---

## Files to Modify

### Phase 1 (X-Axis)
- `Charts/packages/chart-render-canvas2d/src/index.ts` - Add visibility listener
- `Charts/packages/chart-render-canvas2d/src/tick-coordinator.ts` - Add width tracking

### Phase 2 (Entry/Exit)
- `Charts/packages/chart-render-canvas2d/src/index.ts` - Modify `buildPluginState()` (1-2 lines)

### Phase 3 (Jitter) - Investigation
- `Charts/packages/chart-render-canvas2d/src/coordinate-stabilizer.ts` - Instrument/fix
- `Charts/packages/chart-interaction/src/physics.ts` - Verify initial velocity

### Phase 4 (Strategy Pane)
- `extensions/quantlab/webview/chart/index.ts` - Add toggle button
- `Charts/packages/chart-render-canvas2d/src/index.ts` - Add `setPaneVisible()` API
- `extensions/quantlab/src/views/chart/ChartStateStore.ts` - Persist state

### Phase 5 (Parameters)
- `extensions/quantlab/webview/chart/parameterPanel.ts` - Grouping + dirty state
- `extensions/quantlab/webview/chart/chart.css` - Sticky footer + fixed widths

---

## Conclusion

The original plan demonstrates good intuition about the problem areas but makes several assumptions that don't hold against the actual codebase. The most critical corrections are:

1. **Phase 2:** The fix is simpler than expected - just pass `panOverscrollPx` to `buildPluginState()`
2. **Phase 3:** Investigation needed since pan cache is disabled
3. **Phase 1:** Implementation approach is correct, just needs to be done

I recommend implementing Phase 2 first as it's a high-confidence, low-risk fix that will immediately improve UX.
