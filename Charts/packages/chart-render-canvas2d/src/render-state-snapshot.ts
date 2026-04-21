/**
 * Render state snapshot for perfect layer synchronization.
 * 
 * Captures a lightweight snapshot of the current render state at frame start,
 * ensuring all render passes (underlay, series, overlay) use identical state.
 * 
 * Key principle: All layers use the same state snapshot, guaranteeing perfect
 * alignment between grid, series, axes, and overlay elements.
 */

import type { VisibleTimeRange } from '@charts-plus/chart-core';

export class RenderStateSnapshot {
  readonly visibleRange: VisibleTimeRange;
  readonly panOffset: number;
  readonly timestamp: number;
  readonly frameId: number;

  constructor(
    visibleRange: VisibleTimeRange,
    panOffset: number,
    frameId: number,
  ) {
    // Store references (not copies) for efficiency
    // The visibleRange object is already immutable from TimeScale
    this.visibleRange = visibleRange;
    this.panOffset = panOffset;
    this.timestamp = performance.now();
    this.frameId = frameId;
  }

  /**
   * Check if this snapshot is from the current frame.
   */
  isCurrentFrame(currentFrameId: number): boolean {
    return this.frameId === currentFrameId;
  }

  /**
   * Get age of this snapshot in milliseconds.
   */
  getAge(): number {
    return performance.now() - this.timestamp;
  }
}

