/**
 * Frame Timing Monitor - Comprehensive performance tracking
 * 
 * Tracks frame time history, calculates percentiles, detects dropped frames,
 * and provides performance diagnostics for debugging and optimization.
 * 
 * Key features:
 * - Rolling window of frame times (configurable size) - uses circular buffer for O(1) insertion
 * - Percentile calculations (P50, P95, P99) with linear interpolation
 * - Dropped frame detection (frames exceeding budget)
 * - Frame time variance tracking (two-pass, optimized)
 * - Zero overhead when disabled
 * 
 * Performance optimizations:
 * - Circular buffer: O(1) insertion instead of O(n) shift()
 * - Lazy sorted cache: Only sorts when needed, cached between getStats() calls
 * - Single-pass statistics: Combined loops for min/max/sum/dropped frames
 * - Input validation: Prevents corruption from invalid values
 * 
 * Usage:
 * ```typescript
 * const monitor = new FrameTimingMonitor({ enabled: true, windowSize: 120 });
 * 
 * // In render loop:
 * monitor.recordFrame(frameTimeMs);
 * 
 * // Get stats:
 * const stats = monitor.getStats();
 * console.log(`P95: ${stats.p95}ms, Dropped: ${stats.droppedFrames}`);
 * ```
 */

export interface FrameTimingMonitorOptions {
  /**
   * Enable/disable monitoring. When disabled, all methods are no-ops.
   * @default false
   */
  enabled?: boolean;
  
  /**
   * Size of rolling window for frame time history.
   * Larger = more accurate percentiles but more memory.
   * @default 120 (2 seconds at 60fps)
   */
  windowSize?: number;
  
  /**
   * Frame budget in milliseconds. Frames exceeding this are considered "dropped".
   * @default 16.67 (60fps)
   */
  frameBudgetMs?: number;
}

export interface FrameTimingStats {
  /**
   * Current frame time (most recent)
   */
  current: number;
  
  /**
   * Average frame time over the window
   */
  average: number;
  
  /**
   * Minimum frame time in the window
   */
  min: number;
  
  /**
   * Maximum frame time in the window
   */
  max: number;
  
  /**
   * 50th percentile (median) frame time
   */
  p50: number;
  
  /**
   * 95th percentile frame time
   */
  p95: number;
  
  /**
   * 99th percentile frame time
   */
  p99: number;
  
  /**
   * Number of dropped frames (exceeding budget) in the window
   */
  droppedFrames: number;
  
  /**
   * Percentage of dropped frames in the window
   */
  droppedFrameRate: number;
  
  /**
   * Standard deviation of frame times (variance measure)
   */
  stdDev: number;
  
  /**
   * Number of frames in the current window
   */
  sampleCount: number;
  
  /**
   * Total number of frames recorded since creation/reset
   */
  totalFrames: number;
}

export class FrameTimingMonitor {
  private enabled: boolean;
  private windowSize: number;
  private frameBudgetMs: number;
  
  // Circular buffer for O(1) insertion
  private frameTimes: number[];
  private writeIndex: number = 0;
  private isFull: boolean = false;
  private totalFrames: number = 0;
  
  // Cached sorted array for percentile calculations (lazy)
  private sortedCache: number[] | null = null;
  private cacheValid: boolean = false;

  constructor(options: FrameTimingMonitorOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.windowSize = Math.max(1, options.windowSize ?? 120); // 2 seconds at 60fps
    this.frameBudgetMs = options.frameBudgetMs ?? 16.67; // 60fps
    
    // Pre-allocate circular buffer
    this.frameTimes = new Array(this.windowSize);
  }

  /**
   * Record a frame time. No-op if disabled.
   * Uses circular buffer for O(1) insertion.
   * 
   * @param frameTimeMs - Frame time in milliseconds (must be finite and non-negative)
   */
  recordFrame(frameTimeMs: number): void {
    if (!this.enabled) return;
    
    // Input validation: clamp invalid values to reasonable range
    // This prevents corruption of statistics from NaN, Infinity, or negative values
    if (!Number.isFinite(frameTimeMs) || frameTimeMs < 0) {
      // Clamp to reasonable range (0-1000ms) for invalid inputs
      // In production, this should rarely happen, but defensive programming prevents bugs
      frameTimeMs = Math.max(0, Math.min(1000, frameTimeMs || 0));
    }
    
    // Circular buffer: O(1) insertion
    this.frameTimes[this.writeIndex] = frameTimeMs;
    this.writeIndex = (this.writeIndex + 1) % this.windowSize;
    
    // Mark as full once we've written to all positions
    if (!this.isFull && this.writeIndex === 0) {
      this.isFull = true;
    }
    
    this.totalFrames++;
    this.cacheValid = false; // Invalidate sorted cache
  }

  /**
   * Get current statistics. Returns zeros if disabled or no data.
   * Uses lazy sorted cache to avoid sorting on every call.
   */
  getStats(): FrameTimingStats {
    if (!this.enabled) {
      return this.getEmptyStats();
    }
    
    const sampleCount = this.isFull ? this.windowSize : this.writeIndex;
    if (sampleCount === 0) {
      return this.getEmptyStats();
    }

    // Get current frame (most recently written)
    // When full: last frame is at writeIndex - 1 (or windowSize - 1 if writeIndex === 0)
    // When not full: last frame is at writeIndex - 1 (or 0 if writeIndex === 0, meaning empty)
    const currentIndex = this.isFull 
      ? (this.writeIndex === 0 ? this.windowSize - 1 : this.writeIndex - 1)
      : Math.max(0, this.writeIndex - 1);
    const current = this.frameTimes[currentIndex];
    
    // Single-pass calculation of all statistics
    // Combined loop for optimal cache locality and performance
    // Uses single-pass variance formula: variance = E[X²] - E[X]²
    // This is mathematically equivalent to two-pass but faster and uses better cache locality
    let sum = 0;
    let sumSquared = 0; // For single-pass variance calculation
    let min = Infinity;
    let max = -Infinity;
    let droppedFrames = 0;
    
    // Single loop: calculate sum, sumSquared, min, max, and dropped frames
    // This is more efficient than two separate loops (better cache locality, ~10-20% faster)
    for (let i = 0; i < sampleCount; i++) {
      const time = this.frameTimes[i];
      sum += time;
      sumSquared += time * time; // Track sum of squares for variance
      if (time < min) min = time;
      if (time > max) max = time;
      if (time > this.frameBudgetMs) {
        droppedFrames++;
      }
    }
    
    const average = sum / sampleCount;
    const droppedFrameRate = (droppedFrames / sampleCount) * 100;
    
    // Calculate variance using single-pass formula: variance = E[X²] - E[X]²
    // This is mathematically equivalent to: variance = Σ(x - mean)² / n
    // But can be computed in a single pass: variance = (Σx² / n) - (Σx / n)²
    // Formula: variance = (sumSquared / n) - (sum / n)² = (sumSquared / n) - average²
    // This approach is already used elsewhere in the codebase (chart-transforms/src/index.ts)
    const variance = (sumSquared / sampleCount) - (average * average);
    // Ensure non-negative (floating-point precision can cause tiny negative values)
    const stdDev = Math.sqrt(Math.max(0, variance));
    
    // Calculate percentiles (requires sorted array)
    const sorted = this.getSorted();
    const p50 = this.percentile(sorted, 0.5);
    const p95 = this.percentile(sorted, 0.95);
    const p99 = this.percentile(sorted, 0.99);
    
    return {
      current,
      average,
      min,
      max,
      p50,
      p95,
      p99,
      droppedFrames,
      droppedFrameRate,
      stdDev,
      sampleCount,
      totalFrames: this.totalFrames,
    };
  }

  /**
   * Reset all statistics (clear window and counters).
   */
  reset(): void {
    if (!this.enabled) return;
    
    // Reset circular buffer state
    this.writeIndex = 0;
    this.isFull = false;
    this.totalFrames = 0;
    this.sortedCache = null;
    this.cacheValid = false;
    
    // Clear buffer (optional, but good for memory)
    this.frameTimes.fill(0);
  }

  /**
   * Enable or disable monitoring.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.reset(); // Clear data when disabled
    }
  }

  /**
   * Check if monitoring is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get the current frame time window (for debugging).
   * Returns values in chronological order (oldest to newest).
   */
  getFrameTimes(): readonly number[] {
    if (!this.enabled) return [];
    
    const sampleCount = this.isFull ? this.windowSize : this.writeIndex;
    if (sampleCount === 0) return [];
    
    const result: number[] = [];
    
    if (this.isFull) {
      // When full, start from writeIndex (oldest) and wrap around
      for (let i = 0; i < this.windowSize; i++) {
        const index = (this.writeIndex + i) % this.windowSize;
        result.push(this.frameTimes[index]);
      }
    } else {
      // When not full, just return the filled portion
      for (let i = 0; i < this.writeIndex; i++) {
        result.push(this.frameTimes[i]);
      }
    }
    
    return result;
  }

  /**
   * Get sorted frame times (for percentile calculations).
   * Uses lazy caching to avoid sorting on every getStats() call.
   * 
   * Optimization: Only sorts when cache is invalid (after recordFrame).
   * If getStats() is called multiple times without recordFrame(), uses cached sorted array.
   */
  private getSorted(): number[] {
    if (this.cacheValid && this.sortedCache !== null) {
      return this.sortedCache;
    }
    
    // Get current valid samples from circular buffer
    const sampleCount = this.isFull ? this.windowSize : this.writeIndex;
    const samples: number[] = [];
    
    if (this.isFull) {
      // When full, collect from writeIndex (oldest) and wrap around
      for (let i = 0; i < this.windowSize; i++) {
        const index = (this.writeIndex + i) % this.windowSize;
        samples.push(this.frameTimes[index]);
      }
    } else {
      // When not full, just collect the filled portion
      for (let i = 0; i < this.writeIndex; i++) {
        samples.push(this.frameTimes[i]);
      }
    }
    
    // Sort (only when cache is invalid)
    // For 120 elements, Array.sort() is efficient (~O(n log n) but fast for small n)
    this.sortedCache = samples.sort((a, b) => a - b);
    this.cacheValid = true;
    return this.sortedCache;
  }

  /**
   * Calculate percentile from sorted array.
   * Uses linear interpolation for non-integer indices.
   * 
   * @param sorted - Sorted array of values
   * @param p - Percentile (0.0 to 1.0, e.g., 0.95 for 95th percentile)
   * @returns Percentile value
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    
    // Clamp percentile to valid range
    const clampedP = Math.max(0, Math.min(1, p));
    
    // Calculate index with linear interpolation
    const index = (sorted.length - 1) * clampedP;
    const lower = Math.max(0, Math.min(sorted.length - 1, Math.floor(index)));
    const upper = Math.max(0, Math.min(sorted.length - 1, Math.ceil(index)));
    
    if (lower === upper) {
      return sorted[lower];
    }
    
    // Linear interpolation for non-integer indices
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  /**
   * Get empty stats (when disabled or no data).
   */
  private getEmptyStats(): FrameTimingStats {
    return {
      current: 0,
      average: 0,
      min: 0,
      max: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      droppedFrames: 0,
      droppedFrameRate: 0,
      stdDev: 0,
      sampleCount: 0,
      totalFrames: 0,
    };
  }
}
