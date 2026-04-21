# Interaction and Hit Testing (V3)
**Goal:** best-in-class feel without stalls; preserve “no hover readback” rule.

---

## 1) InputState normalization
Main thread captures events and writes a compact InputState:
- pointer position
- button/modifier state
- wheel deltas
- touch/pinch data

Use coalesced pointer events when available to avoid “staircase” movement.

---

## 2) Gesture engine
Worker (Tier A) or Renderer runtime (Tier B) processes InputState:
- pan with inertia
- zoom anchored at cursor/pinch center
- crosshair tracking
- selection box

Implementation details:
- maintain a state machine (Idle, Panning, Zooming, Selecting, Editing)
- inertia uses exponential decay with tunable constants
- always clamp to valid time/price ranges

---

## 3) Crosshair logic (contract)
- crosshair pass is independent and always drawn
- tooltip values:
  - compute bar index analytically from pointer X
  - fetch OHLC from CPU arrays
- no dependency on tile cache rebuild

---

## 4) Hit testing — CPU first
### 4.1 Series
- O(1) index lookup from x coordinate
- optional binary search if time axis is irregular

### 4.2 Drawings
Maintain spatial index:
- bins for handle points
- bins for segments/rectangles
- test nearest first, then precise math

Update index incrementally on edits.

---

## 5) Optional click-only GPU picking
Allowed only for:
- very dense overlays
- click selection (not hover)

Pipeline:
- render ID texture offscreen
- read one pixel on click
- accept 1-frame latency

---

## 6) Accessibility notes
- keyboard navigation for crosshair (left/right step)
- focus outlines and ARIA for UI controls
- avoid trapping scroll unintentionally on mobile

---

## 7) Tests
- crosshair under heavy load remains responsive
- drawing edit handles stay responsive during tile rebuilds
- mobile gestures (pinch zoom, long press crosshair) validated
