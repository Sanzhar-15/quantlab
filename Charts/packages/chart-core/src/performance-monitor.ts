/**
 * Performance monitoring for frame time and memory usage.
 */

/**
 * Performance metrics.
 */
export interface PerformanceMetrics {
  fps: number;
  frameTimeMs: number;
  frameTimeP95: number;
  frameTimeP99: number;
  memoryUsageMB: number;
  gpuMemoryUsageMB?: number;
  drawCalls: number;
  triangles: number;
}

/**
 * Performance monitor.
 */
export class PerformanceMonitor {
  private frameTimes: number[] = [];
  private maxSamples = 1000;
  private lastFrameTime = 0;
  private frameCount = 0;
  private startTime = performance.now();

  /**
   * Record frame time.
   */
  public recordFrame(frameTime: number): void {
    this.frameTimes.push(frameTime);
    if (this.frameTimes.length > this.maxSamples) {
      this.frameTimes.shift();
    }
    this.lastFrameTime = frameTime;
    this.frameCount++;
  }

  /**
   * Get current FPS.
   */
  public getFPS(): number {
    if (this.lastFrameTime === 0) {
      return 0;
    }
    return 1000 / this.lastFrameTime;
  }

  /**
   * Get average frame time.
   */
  public getAverageFrameTime(): number {
    if (this.frameTimes.length === 0) {
      return 0;
    }
    const sum = this.frameTimes.reduce((a, b) => a + b, 0);
    return sum / this.frameTimes.length;
  }

  /**
   * Get percentile frame time.
   */
  public getPercentileFrameTime(percentile: number): number {
    if (this.frameTimes.length === 0) {
      return 0;
    }
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const index = Math.floor((percentile / 100) * sorted.length);
    return sorted[index] || 0;
  }

  /**
   * Get all metrics.
   */
  public getMetrics(): PerformanceMetrics {
    return {
      fps: this.getFPS(),
      frameTimeMs: this.getAverageFrameTime(),
      frameTimeP95: this.getPercentileFrameTime(95),
      frameTimeP99: this.getPercentileFrameTime(99),
      memoryUsageMB: this.getMemoryUsage(),
      drawCalls: 0, // TODO: Track from renderer
      triangles: 0, // TODO: Track from renderer
    };
  }

  /**
   * Get memory usage (MB).
   */
  private getMemoryUsage(): number {
    if ('memory' in performance && (performance as any).memory) {
      const memory = (performance as any).memory;
      return memory.usedJSHeapSize / (1024 * 1024);
    }
    return 0;
  }

  /**
   * Reset metrics.
   */
  public reset(): void {
    this.frameTimes = [];
    this.lastFrameTime = 0;
    this.frameCount = 0;
    this.startTime = performance.now();
  }

  /**
   * Get frame count.
   */
  public getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Get uptime (seconds).
   */
  public getUptime(): number {
    return (performance.now() - this.startTime) / 1000;
  }
}

