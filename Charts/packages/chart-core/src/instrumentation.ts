/**
 * Performance instrumentation and debug overlay.
 * 
 * Provides frame timing, render metrics, and a debug HUD for development.
 */

export interface FrameMetrics {
  frameTime: number;        // Total frame time (ms)
  renderTime: number;       // Render time (ms)
  underlayTime: number;     // Underlay pass time (ms)
  seriesTime: number;       // Series pass time (ms)
  overlayTime: number;      // Overlay pass time (ms)
  panCacheHit: boolean;     // Whether pan cache was used
  droppedFrame: boolean;    // Whether frame was dropped (> 16.67ms)
  timestamp: number;        // Frame timestamp
}

export interface PerformanceStats {
  frameCount: number;
  droppedFrames: number;
  avgFrameTime: number;
  p50FrameTime: number;
  p95FrameTime: number;
  p99FrameTime: number;
  panCacheHitRate: number;
}

/**
 * Performance monitor for tracking frame metrics.
 */
export class PerformanceMonitor {
  private metrics: FrameMetrics[] = [];
  private maxSamples: number;
  private enabled: boolean = false;

  constructor(maxSamples: number = 300) {
    this.maxSamples = maxSamples;
  }

  /**
   * Enable/disable monitoring.
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.metrics = [];
    }
  }

  /**
   * Check if monitoring is enabled.
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Record a frame metric.
   */
  public recordFrame(metrics: FrameMetrics): void {
    if (!this.enabled) return;

    this.metrics.push(metrics);
    if (this.metrics.length > this.maxSamples) {
      this.metrics.shift();
    }
  }

  /**
   * Get all recorded metrics.
   */
  public getMetrics(): FrameMetrics[] {
    return [...this.metrics];
  }

  /**
   * Get performance statistics.
   */
  public getStats(): PerformanceStats {
    if (this.metrics.length === 0) {
      return {
        frameCount: 0,
        droppedFrames: 0,
        avgFrameTime: 0,
        p50FrameTime: 0,
        p95FrameTime: 0,
        p99FrameTime: 0,
        panCacheHitRate: 0,
      };
    }

    const frameTimes = this.metrics.map((m) => m.frameTime).sort((a, b) => a - b);
    const droppedFrames = this.metrics.filter((m) => m.droppedFrame).length;
    const panCacheHits = this.metrics.filter((m) => m.panCacheHit).length;

    const sum = frameTimes.reduce((a, b) => a + b, 0);
    const avg = sum / frameTimes.length;

    const p50Idx = Math.floor(frameTimes.length * 0.5);
    const p95Idx = Math.floor(frameTimes.length * 0.95);
    const p99Idx = Math.floor(frameTimes.length * 0.99);

    return {
      frameCount: this.metrics.length,
      droppedFrames,
      avgFrameTime: avg,
      p50FrameTime: frameTimes[p50Idx] ?? 0,
      p95FrameTime: frameTimes[p95Idx] ?? 0,
      p99FrameTime: frameTimes[p99Idx] ?? 0,
      panCacheHitRate: this.metrics.length > 0 ? panCacheHits / this.metrics.length : 0,
    };
  }

  /**
   * Clear all metrics.
   */
  public clear(): void {
    this.metrics = [];
  }

  /**
   * Get histogram data for visualization.
   */
  public getHistogram(buckets: number = 20): { min: number; max: number; counts: number[] } {
    if (this.metrics.length === 0) {
      return { min: 0, max: 0, counts: [] };
    }

    const frameTimes = this.metrics.map((m) => m.frameTime);
    const min = Math.min(...frameTimes);
    const max = Math.max(...frameTimes);
    const bucketSize = (max - min) / buckets;

    const counts = new Array(buckets).fill(0);
    frameTimes.forEach((time) => {
      const bucket = Math.min(Math.floor((time - min) / bucketSize), buckets - 1);
      counts[bucket]++;
    });

    return { min, max, counts };
  }
}

/**
 * Debug overlay for displaying performance metrics.
 */
export class DebugOverlay {
  private container: HTMLElement | null = null;
  private monitor: PerformanceMonitor;
  private updateInterval: number = 500; // ms
  private lastUpdate: number = 0;

  constructor(monitor: PerformanceMonitor) {
    this.monitor = monitor;
  }

  /**
   * Show the debug overlay.
   */
  public show(parentElement: HTMLElement): void {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: absolute;
      top: 10px;
      right: 10px;
      background: rgba(0, 0, 0, 0.8);
      color: #fff;
      font-family: monospace;
      font-size: 12px;
      padding: 10px;
      border-radius: 4px;
      z-index: 10000;
      pointer-events: none;
      min-width: 200px;
    `;

    parentElement.appendChild(this.container);
    this.update();
  }

  /**
   * Hide the debug overlay.
   */
  public hide(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }

  /**
   * Update the debug overlay (call every frame).
   */
  public update(): void {
    if (!this.container) return;

    const now = performance.now();
    if (now - this.lastUpdate < this.updateInterval) {
      return;
    }
    this.lastUpdate = now;

    const stats = this.monitor.getStats();

    this.container.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 5px;">Performance</div>
      <div>Frames: ${stats.frameCount}</div>
      <div>Dropped: ${stats.droppedFrames} (${((stats.droppedFrames / stats.frameCount) * 100).toFixed(1)}%)</div>
      <div>Avg: ${stats.avgFrameTime.toFixed(2)}ms</div>
      <div>P50: ${stats.p50FrameTime.toFixed(2)}ms</div>
      <div>P95: ${stats.p95FrameTime.toFixed(2)}ms</div>
      <div>P99: ${stats.p99FrameTime.toFixed(2)}ms</div>
      <div>Cache Hit: ${(stats.panCacheHitRate * 100).toFixed(1)}%</div>
    `;
  }

  /**
   * Toggle visibility.
   */
  public toggle(parentElement: HTMLElement): void {
    if (this.container) {
      this.hide();
    } else {
      this.show(parentElement);
    }
  }
}

/**
 * Global instrumentation API.
 */
class InstrumentationAPI {
  private monitor: PerformanceMonitor;
  private overlay: DebugOverlay;

  constructor() {
    this.monitor = new PerformanceMonitor();
    this.overlay = new DebugOverlay(this.monitor);
  }

  public getMonitor(): PerformanceMonitor {
    return this.monitor;
  }

  public getOverlay(): DebugOverlay {
    return this.overlay;
  }

  public enable(): void {
    this.monitor.setEnabled(true);
  }

  public disable(): void {
    this.monitor.setEnabled(false);
    this.overlay.hide();
  }

  public showOverlay(parentElement: HTMLElement): void {
    this.enable();
    this.overlay.show(parentElement);
  }

  public hideOverlay(): void {
    this.overlay.hide();
  }

  public toggleOverlay(parentElement: HTMLElement): void {
    this.overlay.toggle(parentElement);
    if (this.overlay) {
      this.enable();
    }
  }

  public getStats(): PerformanceStats {
    return this.monitor.getStats();
  }

  public clear(): void {
    this.monitor.clear();
  }
}

/**
 * Global singleton.
 */
let globalInstrumentation: InstrumentationAPI | null = null;

/**
 * Get global instrumentation API.
 */
export function getInstrumentation(): InstrumentationAPI {
  if (!globalInstrumentation) {
    globalInstrumentation = new InstrumentationAPI();
  }
  return globalInstrumentation;
}

/**
 * Install global debug API (window.__chartsPlusDebug).
 */
export function installDebugAPI(): void {
  if (typeof window === 'undefined') return;

  (window as any).__chartsPlusDebug = {
    enable: () => getInstrumentation().enable(),
    disable: () => getInstrumentation().disable(),
    showOverlay: (el?: HTMLElement) => {
      const target = el || document.body;
      getInstrumentation().showOverlay(target);
    },
    hideOverlay: () => getInstrumentation().hideOverlay(),
    getStats: () => getInstrumentation().getStats(),
    clear: () => getInstrumentation().clear(),
  };
}

