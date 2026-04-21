/**
 * FrameBudget - Frame time budget enforcement
 * 
 * Ensures rendering stays within frame budget (12ms target for 60fps with 4ms headroom).
 * Provides priority-based skipping to maintain smoothness during heavy interactions.
 */

const FRAME_BUDGET_MS = 12; // Target 60fps with 4ms headroom (16.67ms - 4ms)
const CRITICAL_BUDGET_MS = 6; // Critical pass (underlay) should complete within 6ms
const STANDARD_BUDGET_MS = 10; // Standard pass (series) should complete within 10ms

export type Priority = 'critical' | 'standard' | 'optional';

export class FrameBudget {
  private startTime: number = 0;
  private elapsed: number = 0;
  
  /**
   * Start a new frame - call this at the beginning of each render frame.
   */
  startFrame(): void {
    this.startTime = performance.now();
    this.elapsed = 0;
  }
  
  /**
   * Get elapsed time since frame start (in milliseconds).
   */
  getElapsedMs(): number {
    if (this.startTime === 0) return 0;
    this.elapsed = performance.now() - this.startTime;
    return this.elapsed;
  }
  
  /**
   * Check if there's time remaining in the frame budget.
   */
  hasTimeRemaining(): boolean {
    return this.getElapsedMs() < FRAME_BUDGET_MS;
  }
  
  /**
   * Check if a pass with the given priority should be skipped.
   * 
   * - Critical: Never skip (underlay - grid, axes, background)
   * - Standard: Skip if elapsed > 10ms (series rendering)
   * - Optional: Skip if elapsed > 12ms (overlay - crosshair, markers)
   */
  shouldSkip(priority: Priority): boolean {
    const elapsed = this.getElapsedMs();
    
    switch (priority) {
      case 'critical':
        return false; // Never skip critical passes
      case 'standard':
        return elapsed > STANDARD_BUDGET_MS;
      case 'optional':
        return elapsed > FRAME_BUDGET_MS;
      default:
        return false;
    }
  }
  
  /**
   * Get the remaining budget for the current frame (in milliseconds).
   */
  getRemainingMs(): number {
    return Math.max(0, FRAME_BUDGET_MS - this.getElapsedMs());
  }
  
  /**
   * Check if the frame is over budget (dropped frame).
   */
  isOverBudget(): boolean {
    return this.getElapsedMs() > FRAME_BUDGET_MS;
  }
}

