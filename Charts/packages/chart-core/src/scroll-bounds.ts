/**
 * Scroll Boundaries Utility (V7 Phase 4 - 09-SCROLL-BOUNDARIES)
 * 
 * Pure functions for calculating and applying scroll boundaries.
 * Boundaries are LIMITS, not values - they prevent scrolling too far,
 * but don't set the viewport to show all data.
 */

export const MIN_VISIBLE_BARS = 5;  // Minimum bars that must be visible when scrolling into whitespace

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

