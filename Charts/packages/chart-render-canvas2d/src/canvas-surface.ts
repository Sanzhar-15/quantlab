import { CoordinateStabilizer } from './coordinate-stabilizer';

export type SurfaceSize = {
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  dpr: number;
};

export type CanvasSurfaceOptions = {
  autoSize?: boolean;
  width?: number;
  height?: number;
  dpr?: number;
  onResize?: (size: SurfaceSize) => void;
  absolute?: boolean;
  zIndex?: number;
  className?: string;
  pointerEvents?: 'auto' | 'none';
  deferContext?: boolean;
  contextAttributes?: CanvasRenderingContext2DSettings;
};

function getDevicePixelRatio(): number {
  if (typeof window === 'undefined') return 1;
  return window.devicePixelRatio || 1;
}

// V7: DPR Ceiling - Cap effective DPR to prevent memory issues on high-DPI displays
const MAX_CANVAS_PIXELS = 8_000_000;  // 8 megapixels max per canvas
const MAX_DPR = 2.5;  // Maximum effective DPR
const MIN_DPR = 1.0;  // Minimum effective DPR

/**
 * Calculate effective DPR with ceiling to prevent excessive memory usage.
 * 
 * Limits:
 * - Maximum DPR: 2.5 (prevents 4K @ 200% from using 4x DPR)
 * - Maximum canvas pixels: 8M (prevents huge canvases on large displays)
 * 
 * @param cssWidth - CSS width in pixels
 * @param cssHeight - CSS height in pixels
 * @param deviceDpr - Raw device pixel ratio (from window.devicePixelRatio)
 * @returns Effective DPR (capped to prevent memory issues)
 */
function calculateEffectiveDpr(
  cssWidth: number,
  cssHeight: number,
  deviceDpr: number = getDevicePixelRatio()
): number {
  const cssPixels = cssWidth * cssHeight;

  // Calculate max DPR from pixel budget (8M pixels max)
  const maxDprFromBudget = cssPixels > 0
    ? Math.sqrt(MAX_CANVAS_PIXELS / cssPixels)
    : MAX_DPR;

  // Apply all limits: min 1.0, max 2.5, and budget limit
  return Math.max(MIN_DPR, Math.min(deviceDpr, maxDprFromBudget, MAX_DPR));
}

/**
 * Check if devicePixelContentBox is supported by ResizeObserver.
 * This provides more precise physical pixel sizing than devicePixelRatio.
 */
function supportsDevicePixelContentBox(): boolean {
  if (typeof ResizeObserver === 'undefined') return false;
  // Feature detection: try to create an observer with the option
  try {
    const testEl = document.createElement('div');
    let supported = false;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]?.devicePixelContentBoxSize) {
        supported = true;
      }
    });
    observer.observe(testEl, { box: 'device-pixel-content-box' } as ResizeObserverOptions);
    observer.disconnect();
    testEl.remove();
    // If no error was thrown, it's likely supported
    return true;
  } catch {
    return false;
  }
}

const _devicePixelContentBoxSupported = supportsDevicePixelContentBox();

export class CanvasSurface {
  private readonly _container: HTMLElement;
  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D | null;
  private _ctxDetached = false;
  private readonly _autoSize: boolean;
  private _resizeObserver: ResizeObserver | null = null;
  private _cssWidth = 0;
  private _cssHeight = 0;
  private _dpr = 1;
  private _dprOverride: number | undefined;
  private _onResize: ((size: SurfaceSize) => void) | undefined;
  private _contextAttributes: CanvasRenderingContext2DSettings | undefined;
  private readonly _stabilizer: CoordinateStabilizer;

  public constructor(container: HTMLElement, options: CanvasSurfaceOptions = {}) {
    this._container = container;
    this._autoSize = options.autoSize === true;
    this._dprOverride = options.dpr;
    this._onResize = options.onResize;
    this._contextAttributes = options.contextAttributes;
    this._stabilizer = new CoordinateStabilizer();

    this._canvas = document.createElement('canvas');
    if (options.className) {
      this._canvas.className = options.className;
    }
    this._canvas.style.display = 'block';
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    if (options.absolute) {
      this._canvas.style.position = 'absolute';
      this._canvas.style.left = '0';
      this._canvas.style.top = '0';
    }
    if (options.zIndex !== undefined) {
      this._canvas.style.zIndex = String(options.zIndex);
    }
    if (options.pointerEvents) {
      this._canvas.style.pointerEvents = options.pointerEvents;
    }
    this._container.appendChild(this._canvas);

    this._ctx = options.deferContext
      ? null
      : this._canvas.getContext('2d', this._contextAttributes);

    if (this._autoSize && typeof ResizeObserver !== 'undefined') {
      // Use devicePixelContentBox for precise HiDPI sizing when available
      this._resizeObserver = new ResizeObserver((entries) => {
        this._handleResizeObserverEntry(entries[0]);
      });

      // Try to observe with devicePixelContentBox for maximum precision
      if (_devicePixelContentBoxSupported) {
        try {
          this._resizeObserver.observe(this._container, { box: 'device-pixel-content-box' } as ResizeObserverOptions);
        } catch {
          // Fallback to default observation
          this._resizeObserver.observe(this._container);
        }
      } else {
        this._resizeObserver.observe(this._container);
      }
    }

    const initialWidth = options.width ?? this._container.clientWidth;
    const initialHeight = options.height ?? this._container.clientHeight;
    this.resize(initialWidth, initialHeight);
  }

  public get canvas(): HTMLCanvasElement {
    return this._canvas;
  }

  public get context(): CanvasRenderingContext2D | null {
    if (!this._ctx && !this._ctxDetached) {
      this._ctx = this._canvas.getContext('2d', this._contextAttributes);
      if (this._ctx) {
        this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      }
    }
    return this._ctx;
  }

  public restoreContext(): void {
    if (!this._ctxDetached && this._canvas.isConnected) return;
    const nextCanvas = document.createElement('canvas');
    nextCanvas.className = this._canvas.className;
    nextCanvas.style.cssText = this._canvas.style.cssText;
    nextCanvas.width = this._canvas.width;
    nextCanvas.height = this._canvas.height;
    if (this._canvas.parentElement) {
      this._canvas.parentElement.replaceChild(nextCanvas, this._canvas);
    } else {
      this._container.appendChild(nextCanvas);
    }
    this._canvas = nextCanvas;
    this._ctxDetached = false;
    this._ctx = this._canvas.getContext('2d', this._contextAttributes);
    if (this._ctx) {
      this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    }
  }

  public detachContext(): void {
    this._ctx = null;
    this._ctxDetached = true;
  }

  public getSize(): SurfaceSize {
    return {
      cssWidth: this._cssWidth,
      cssHeight: this._cssHeight,
      pixelWidth: this._canvas.width,
      pixelHeight: this._canvas.height,
      dpr: this._dpr,
    };
  }

  public resize(width: number, height: number): void {
    const nextCssWidth = Math.max(1, Math.round(width));
    const nextCssHeight = Math.max(1, Math.round(height));

    // V7: Calculate effective DPR with ceiling (needs CSS dimensions first)
    // Temporarily set dimensions for DPR calculation
    const tempCssWidth = this._cssWidth;
    const tempCssHeight = this._cssHeight;
    this._cssWidth = nextCssWidth;
    this._cssHeight = nextCssHeight;

    const nextDpr = this._resolveDpr();

    // Restore if size didn't actually change
    const sizeChanged =
      nextCssWidth !== tempCssWidth || nextCssHeight !== tempCssHeight || nextDpr !== this._dpr;

    if (!sizeChanged) {
      this._cssWidth = tempCssWidth;
      this._cssHeight = tempCssHeight;
      return;
    }

    this._dpr = nextDpr;
    this._cssWidth = nextCssWidth;
    this._cssHeight = nextCssHeight;
    const pixelWidth = Math.max(1, Math.round(nextCssWidth * nextDpr));
    const pixelHeight = Math.max(1, Math.round(nextCssHeight * nextDpr));

    this._canvas.width = pixelWidth;
    this._canvas.height = pixelHeight;
    this._canvas.style.width = `${nextCssWidth}px`;
    this._canvas.style.height = `${nextCssHeight}px`;

    if (this._ctx) {
      this._ctx.setTransform(nextDpr, 0, 0, nextDpr, 0, 0);
    }

    this._onResize?.(this.getSize());
  }

  public setOnResize(handler?: (size: SurfaceSize) => void): void {
    this._onResize = handler;
  }

  /**
   * Set pan active state for coordinate stabilization.
   * When pan is active, stabilization is disabled for direct 1:1 manipulation.
   */
  public setPanActive(active: boolean): void {
    this._stabilizer.setPanActive(active);
  }

  /**
   * Clear coordinate stabilization cache.
   * Useful when layout or scale changes significantly.
   */
  public clearStabilization(): void {
    this._stabilizer.clear();
  }

  public isPanActive(): boolean {
    return this._stabilizer.isPanActive();
  }

  public snapX(x: number, strokeWidth = 1): number {
    const baseSnap = this._snap(x, strokeWidth);

    // Generate a stable key that includes stroke width parity to prevent collisions.
    const roundedPx = Math.round(baseSnap * this._dpr);
    const safeWidth = Number.isFinite(strokeWidth) ? strokeWidth : 1;
    const deviceWidth = Math.max(1, Math.round(safeWidth * this._dpr));
    const strokeParity = deviceWidth % 2 === 1 ? 'odd' : 'even';
    const key = `x-${roundedPx}-${strokeParity}`;

    // Pass raw 'x' as the value to return during pan (for smooth sub-pixel rendering)
    return this._stabilizer.stabilize(x, baseSnap, key, this._dpr);
  }

  public snapY(y: number, strokeWidth = 1): number {
    const baseSnap = this._snap(y, strokeWidth);

    // Generate a stable key that includes stroke width parity to prevent collisions.
    const roundedPx = Math.round(baseSnap * this._dpr);
    const safeWidth = Number.isFinite(strokeWidth) ? strokeWidth : 1;
    const deviceWidth = Math.max(1, Math.round(safeWidth * this._dpr));
    const strokeParity = deviceWidth % 2 === 1 ? 'odd' : 'even';
    const key = `y-${roundedPx}-${strokeParity}`;

    // Pass raw 'y' as the value to return during pan (for smooth sub-pixel rendering)
    return this._stabilizer.stabilize(y, baseSnap, key, this._dpr);
  }

  public alignLineWidth(width: number): number {
    if (!Number.isFinite(width)) return 1;
    const deviceWidth = Math.max(1, Math.round(width * this._dpr));
    return deviceWidth / this._dpr;
  }

  public destroy(): void {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._canvas.remove();
  }

  /**
   * Handle ResizeObserver entry with devicePixelContentBox support.
   * This provides exact physical pixel dimensions for maximum HiDPI sharpness.
   */
  private _handleResizeObserverEntry(entry: ResizeObserverEntry | undefined): void {
    if (!entry) {
      this._resizeToContainer();
      return;
    }

    // Try devicePixelContentBox first (most precise for HiDPI)
    const dpcb = entry.devicePixelContentBoxSize?.[0];
    if (dpcb) {
      const physicalWidth = Math.max(1, Math.round(dpcb.inlineSize));
      const physicalHeight = Math.max(1, Math.round(dpcb.blockSize));
      const cssRect = entry.contentRect;
      const cssWidth = Math.max(1, Math.round(cssRect.width));
      const cssHeight = Math.max(1, Math.round(cssRect.height));

      // Calculate effective DPR from physical vs CSS dimensions
      const rawDpr = cssWidth > 0 ? physicalWidth / cssWidth : getDevicePixelRatio();

      // V7: Apply DPR ceiling to prevent memory issues
      const effectiveDpr = this._dprOverride !== undefined
        ? this._dprOverride
        : calculateEffectiveDpr(cssWidth, cssHeight, rawDpr);

      // Store which method was used for diagnostics
      (this._canvas as any).__dpcbUsed = true;

      this._resizeWithPhysicalPixels(cssWidth, cssHeight, physicalWidth, physicalHeight, effectiveDpr);
      return;
    }

    // Fallback to contentRect with devicePixelRatio
    (this._canvas as any).__dpcbUsed = false;
    const cssRect = entry.contentRect;
    this.resize(cssRect.width, cssRect.height);
  }

  /**
   * Resize using exact physical pixel dimensions from devicePixelContentBox.
   * This bypasses DPR multiplication for maximum precision.
   */
  private _resizeWithPhysicalPixels(
    cssWidth: number,
    cssHeight: number,
    physicalWidth: number,
    physicalHeight: number,
    effectiveDpr: number
  ): void {
    const nextCssWidth = Math.max(1, cssWidth);
    const nextCssHeight = Math.max(1, cssHeight);
    const nextDpr = this._dprOverride ?? effectiveDpr;

    const sizeChanged =
      physicalWidth !== this._canvas.width ||
      physicalHeight !== this._canvas.height ||
      nextCssWidth !== this._cssWidth ||
      nextCssHeight !== this._cssHeight ||
      nextDpr !== this._dpr;

    if (!sizeChanged) return;

    this._dpr = nextDpr;
    this._cssWidth = nextCssWidth;
    this._cssHeight = nextCssHeight;

    // Use exact physical pixels from devicePixelContentBox
    this._canvas.width = physicalWidth;
    this._canvas.height = physicalHeight;
    this._canvas.style.width = `${nextCssWidth}px`;
    this._canvas.style.height = `${nextCssHeight}px`;

    if (this._ctx) {
      // Scale context to work in CSS pixels
      const scaleX = physicalWidth / nextCssWidth;
      const scaleY = physicalHeight / nextCssHeight;
      this._ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    }

    this._onResize?.(this.getSize());
  }

  private _resizeToContainer(): void {
    const rect = this._container.getBoundingClientRect();
    this.resize(rect.width, rect.height);
  }

  private _resolveDpr(): number {
    // V7: Apply DPR ceiling if no override is set
    if (this._dprOverride !== undefined) {
      return Math.max(1, this._dprOverride);
    }

    const deviceDpr = getDevicePixelRatio();

    // V7: Calculate effective DPR with ceiling (prevents memory issues on high-DPI displays)
    // Use current CSS dimensions if available, otherwise use device DPR directly
    if (this._cssWidth > 0 && this._cssHeight > 0) {
      return calculateEffectiveDpr(this._cssWidth, this._cssHeight, deviceDpr);
    }

    // Fallback: use device DPR capped at MAX_DPR (will be recalculated on first resize)
    return Math.min(deviceDpr, MAX_DPR);
  }

  private _snap(value: number, strokeWidth = 1): number {
    // Use consistent rounding with epsilon to prevent boundary jitter.
    // The epsilon ensures that values very close to boundaries (e.g., 0.4999999 vs 0.5000001)
    // round consistently, preventing flickering between adjacent pixels.
    const EPSILON = 1e-10;
    const scaled = (value + EPSILON) * this._dpr;
    const aligned = Math.round(scaled) / this._dpr;

    const safeWidth = Number.isFinite(strokeWidth) ? strokeWidth : 1;
    const deviceWidth = Math.max(1, Math.round(safeWidth * this._dpr));
    const needsHalfPixel = deviceWidth % 2 === 1;
    if (needsHalfPixel) {
      // Center odd-width strokes on the pixel grid.
      return aligned + 0.5 / this._dpr;
    }
    return aligned;
  }
}
