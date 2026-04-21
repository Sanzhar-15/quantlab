/**
 * InputCoalescer - Coalesce input events per frame
 * 
 * Queues multiple input events (pointer moves, wheel events) and processes
 * only the latest event per frame. This reduces render calls from ~60/frame
 * to 1/frame during fast panning, maintaining smoothness while improving performance.
 */

import type { InputIntent } from '@charts-plus/chart-core';

export class InputCoalescer {
  private pendingPointerMove: { x: number; y: number; timestamp: number } | null = null;
  // V7: Right-edge zoom - track Ctrl key state for anchor mode
  private pendingWheel: { deltaX: number; deltaY: number; x: number; y: number; timestamp: number; ctrlKey?: boolean } | null = null;
  
  /**
   * Queue a pointer move event.
   * Multiple moves in the same frame will be coalesced to the latest position.
   */
  queuePointerMove(x: number, y: number, timestamp: number): void {
    this.pendingPointerMove = { x, y, timestamp };
  }
  
  /**
   * Queue a wheel event.
   * Multiple wheel events in the same frame will be coalesced to the latest delta.
   * V7: Right-edge zoom - Ctrl key state determines anchor mode
   */
  queueWheel(deltaX: number, deltaY: number, x: number, y: number, timestamp: number, ctrlKey?: boolean): void {
    // Accumulate wheel deltas instead of replacing (user might scroll multiple times)
    if (this.pendingWheel) {
      this.pendingWheel.deltaX += deltaX;
      this.pendingWheel.deltaY += deltaY;
      // Update position to latest
      this.pendingWheel.x = x;
      this.pendingWheel.y = y;
      this.pendingWheel.timestamp = timestamp;
      // V7: Preserve Ctrl key state (last value wins if multiple wheel events coalesced)
      if (ctrlKey !== undefined) {
        this.pendingWheel.ctrlKey = ctrlKey;
      }
    } else {
      this.pendingWheel = { deltaX, deltaY, x, y, timestamp, ctrlKey };
    }
  }
  
  /**
   * Process queued events and return coalesced InputIntent.
   * Call this once per frame before rendering.
   * Returns null if no events were queued.
   */
  processFrame(): InputIntent | null {
    
    const intent: InputIntent = {};
    let hasIntent = false;
    
    if (this.pendingPointerMove) {
      intent.pointer = {
        x: this.pendingPointerMove.x,
        y: this.pendingPointerMove.y,
        type: 'move',
      };
      this.pendingPointerMove = null;
      hasIntent = true;
    }
    
    if (this.pendingWheel) {
      intent.wheel = {
        deltaX: this.pendingWheel.deltaX,
        deltaY: this.pendingWheel.deltaY,
        x: this.pendingWheel.x,
        y: this.pendingWheel.y,
        // V7: Pass Ctrl key state for right-edge zoom
        ctrlKey: this.pendingWheel.ctrlKey,
      };
      this.pendingWheel = null;
      hasIntent = true;
    }
    
    return hasIntent ? intent : null;
  }
  
  /**
   * Clear all pending events.
   * Useful when cancelling interactions or resetting state.
   */
  clear(): void {
    this.pendingPointerMove = null;
    this.pendingWheel = null;
  }

  /**
   * Clear only the pending pointer move.
   * Useful when pointer leaves the plot to avoid stale updates.
   */
  clearPointerMove(): void {
    this.pendingPointerMove = null;
  }
}
