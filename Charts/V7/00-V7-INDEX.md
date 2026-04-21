# V7 Optimization Spec - Master Index

## Overview

This document indexes all V7 optimizations. Each item has its own detailed spec file optimized for Cursor implementation.

**Total Items:** 12 core specs + 1 addendum
**Priority:** All items approved for implementation

> ⚠️ **IMPORTANT:** Read `13-IMPROVEMENTS-ADDENDUM.md` after each spec - it contains critical edge cases and improvements discovered during review.

---

## Implementation Order (Recommended)

### Phase 1: Core Stability (Do First)
These fix potential bugs and instability:

| # | File | Description | Effort |
|---|------|-------------|--------|
| 1 | `01-DELTATIME-CAP.md` | Cap deltaTime in physics to prevent tab-switch bugs | 15 min |
| 12 | `12-POINTER-CAPTURE.md` | Add pointer capture to prevent stuck drag state | 10 min |
| 2 | `02-FRAME-COHERENCE.md` | Ensure layers stay synchronized when skipping passes | 30 min |

### Phase 2: Visual Quality (Smoothness)
These eliminate visual artifacts:

| # | File | Description | Effort |
|---|------|-------------|--------|
| 3 | `03-PIXEL-PERFECT-PAN.md` | Snap pan blitting to physical pixels | 30 min |
| 4 | `04-YAXIS-LOCK-DRAG.md` | Lock Y-axis auto-scale during horizontal drag | 20 min |
| 5 | `05-AXIS-WIDTH-HYSTERESIS.md` | Prevent axis width oscillation | 30 min |
| 7 | `07-LABEL-FORMAT-STABILITY.md` | Prevent label format flip-flop during zoom | 20 min |

### Phase 3: Resource Management
These improve stability on high-end/low-end devices:

| # | File | Description | Effort |
|---|------|-------------|--------|
| 6 | `06-DPR-CEILING.md` | Cap effective DPR and track memory accurately | 45 min |
| 8 | `08-OPAQUE-LAYERS.md` | Make non-overlay layers opaque for compositor efficiency | 15 min |

### Phase 4: User Experience Features
These are new behaviors:

| # | File | Description | Effort |
|---|------|-------------|--------|
| 9 | `09-SCROLL-BOUNDARIES.md` | Allow scrolling into whitespace with minimum visible bars | 45 min |
| 10 | `10-RIGHT-EDGE-ZOOM.md` | Zoom anchored to right edge, Ctrl for cursor anchor | 30 min |
| 11 | `11-CROSSHAIR-SNAP.md` | Crosshair snaps to data points, not pixels | 30 min |

---

## File Format Explanation

Each spec file follows this structure:

```
# Title
## Problem (Why this matters)
## Specification (Exact behavior)
## Implementation Guide (How to implement)
## Code Patterns (Reference code)
## Cursor Decision Points (Where Cursor must decide based on codebase)
## Verification (How to test)
## Dependencies (What must exist first)
```

---

## Dependencies Graph

```
                    ┌──────────────────┐
                    │ 01-DELTATIME-CAP │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
┌─────────────────┐ ┌───────────────┐ ┌────────────────┐
│ 04-YAXIS-LOCK   │ │ 09-SCROLL-    │ │ 10-RIGHT-EDGE  │
│    -DRAG        │ │  BOUNDARIES   │ │    -ZOOM       │
└─────────────────┘ └───────────────┘ └────────────────┘

┌──────────────────┐
│ 12-POINTER-      │ (Independent - do early)
│    CAPTURE       │
└──────────────────┘

┌──────────────────┐
│ 02-FRAME-        │
│   COHERENCE      │──────► 03-PIXEL-PERFECT-PAN
└──────────────────┘

┌──────────────────┐
│ 06-DPR-CEILING   │──────► 08-OPAQUE-LAYERS
└──────────────────┘

┌──────────────────┐         ┌──────────────────┐
│ 05-AXIS-WIDTH-   │         │ 07-LABEL-FORMAT- │
│   HYSTERESIS     │         │   STABILITY      │
└──────────────────┘         └──────────────────┘
        │                            │
        └────────────┬───────────────┘
                     │
                     ▼
              (Both use hysteresis
               pattern - can share)

┌──────────────────┐
│ 11-CROSSHAIR-    │ (Independent)
│    SNAP          │
└──────────────────┘
```

---

## Global Constants (Suggested)

These values appear across multiple specs. Consider centralizing:

```typescript
// config/constants.ts
export const V7_CONSTANTS = {
  // Physics
  MAX_DELTA_TIME_MS: 100,
  
  // Scroll boundaries
  MIN_VISIBLE_BARS: 5,
  MIN_VISIBLE_RATIO: 0.1,  // Fallback: 10% of viewport
  
  // Hysteresis
  AXIS_WIDTH_SHRINK_DELAY_MS: 500,
  AXIS_WIDTH_SHRINK_THRESHOLD_PX: 8,
  LABEL_FORMAT_HYSTERESIS_RATIO: 0.15,
  
  // DPR
  MAX_CANVAS_PIXELS: 8_000_000,  // ~8 megapixels per canvas
  MAX_EFFECTIVE_DPR: 2.5,
  
  // Zoom
  ZOOM_ANCHOR_MODIFIER_KEY: 'Control',  // Ctrl = cursor anchor
};
```

---

## Verification Checklist

After implementing all items, run these tests:

- [ ] Tab switch during animation → no position jump
- [ ] Fast zoom under load → no grid/series desync
- [ ] Pan on 1.5x DPR display → no shimmer
- [ ] Horizontal pan → Y-axis stays stable
- [ ] Zoom across "99.9" → "100.0" → no layout jitter
- [ ] 4K @ 200% scaling → memory stays reasonable
- [ ] Slow zoom → label format doesn't flip-flop
- [ ] Pan to edge of data → stops at minimum visible bars
- [ ] Scroll wheel zoom → right edge stays fixed
- [ ] Ctrl+scroll → cursor position stays fixed
- [ ] Move crosshair → snaps to data points
- [ ] Drag mouse outside canvas → drag continues properly
