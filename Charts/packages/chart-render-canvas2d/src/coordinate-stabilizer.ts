/**
 * Context-aware coordinate stabilization to reduce jitter when idle.
 * 
 * Key principle: During active pan, use direct snapping (1:1 manipulation).
 * When idle, use hysteresis to prevent micro-jitter from floating-point precision.
 * 
 * This ensures:
 * - Perfect 1:1 feel during drag (no lag, no smoothing)
 * - Stable rendering when idle (no visible jitter)
 */

export class CoordinateStabilizer {
  private lastSnapped = new Map<string, number>();
  private panActive = false;
  private readonly HYSTERESIS_THRESHOLD = 0.2; // CSS pixels
  private readonly MAX_CACHE_SIZE = 10000; // Prevent unbounded growth

  /**
   * Set pan active state. When pan is active, stabilization is disabled
   * to preserve direct 1:1 manipulation feel.
   */
  setPanActive(active: boolean): void {
    if (this.panActive === active) return;

    this.panActive = active;

    // Clear cache on pan start to prevent sticking
    if (active) {
      this.lastSnapped.clear();
    }
  }

  /**
   * Stabilized snap with context awareness.
   * 
   * - During active pan: returns raw value (float) to prevent aliasing jitter (no rounding)
   * - When idle: uses hysteresis on the snapped value to prevent oscillation
   * 
   * @param rawValue - The raw float coordinate value
   * @param snappedValue - The value pre-snapped to the pixel grid
   * @param key - Unique key for this coordinate
   * @param dpr - Device pixel ratio
   * @returns Stabilized coordinate value (float during pan, snapped integer during idle)
   */
  stabilize(rawValue: number, snappedValue: number, key: string, dpr: number): number {
    // During active pan: return raw value to prevent aliasing jitter
    if (this.panActive) {
      // Update cache with the snapped value so we have a reference when stopping
      this.lastSnapped.set(key, snappedValue);
      return rawValue;
    }

    // When idle: use hysteresis on the snapped value
    const lastSnap = this.lastSnapped.get(key);
    if (lastSnap !== undefined) {
      const diff = Math.abs(snappedValue - lastSnap);
      const threshold = this.HYSTERESIS_THRESHOLD / dpr;

      // If change is below threshold, maintain previous snapped value
      // This prevents "flickering" between two pixel alignments due to float noise
      if (diff < threshold) {
        return lastSnap;
      }
    }

    // Update cache and return new snapped value
    if (this.lastSnapped.size >= this.MAX_CACHE_SIZE) {
      this.lastSnapped.clear();
    }
    this.lastSnapped.set(key, snappedValue);
    return snappedValue;
  }

  /**
   * Clear all cached values. Useful when:
   * - Theme changes
   * - Scale changes significantly
   * - Layout changes
   */
  clear(): void {
    this.lastSnapped.clear();
  }

  /**
   * Get current pan active state (for debugging)
   */
  isPanActive(): boolean {
    return this.panActive;
  }
}

