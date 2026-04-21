# Mobile Strategy (V3 Add-On)
**Purpose:** Define mobile-specific optimizations, touch interactions, performance constraints, and UX adaptations for phones and tablets.

This document covers:
- touch gesture mapping and recognition
- mobile performance budgets and thermal management
- responsive layout and breakpoints
- battery-conscious rendering
- mobile-specific UI adaptations

> Design goal: **Mobile feels native, not compromised.** Touch interactions must be as smooth as pan/zoom in Apple Maps.

---

## 0) Core requirements

1. **60fps touch interactions** on mid-range devices (3-year-old phones)
2. **Touch-first gestures**: pinch zoom, momentum pan, long-press crosshair
3. **Battery efficiency**: reduce GPU work when idle, pause when backgrounded
4. **Thermal awareness**: degrade gracefully under thermal throttling
5. **Responsive UI**: adapt layout to screen size, not just scale down desktop

---

## 1) Device classification

### 1.1 Device tiers
```typescript
type MobileDeviceTier = "high" | "mid" | "low";

interface DeviceProfile {
  tier: MobileDeviceTier;
  
  // Rendering
  maxDpr: number;
  tileSizePx: number;
  maxTiles: number;
  
  // Budgets
  tileBudgetMB: number;
  atlasBudgetMB: number;
  
  // Performance
  targetFps: number;
  frameBudgetMs: number;
}

const DEVICE_PROFILES: Record<MobileDeviceTier, DeviceProfile> = {
  high: {
    tier: "high",
    maxDpr: 3.0,
    tileSizePx: 512,
    maxTiles: 64,
    tileBudgetMB: 128,
    atlasBudgetMB: 32,
    targetFps: 60,
    frameBudgetMs: 16,
  },
  mid: {
    tier: "mid",
    maxDpr: 2.0,
    tileSizePx: 256,
    maxTiles: 48,
    tileBudgetMB: 96,
    atlasBudgetMB: 24,
    targetFps: 60,
    frameBudgetMs: 16,
  },
  low: {
    tier: "low",
    maxDpr: 1.5,
    tileSizePx: 256,
    maxTiles: 32,
    tileBudgetMB: 64,
    atlasBudgetMB: 16,
    targetFps: 30,
    frameBudgetMs: 33,
  },
};
```

### 1.2 Device detection
```typescript
function classifyDevice(): MobileDeviceTier {
  // Memory-based classification
  const memory = (navigator as any).deviceMemory;  // GB, if available
  
  // GPU-based classification (from WebGPU adapter info)
  const gpuTier = detectGPUTier();  // From tier selection microbenchmark
  
  // Heuristics
  if (memory >= 6 && gpuTier === "high") return "high";
  if (memory >= 4 || gpuTier === "mid") return "mid";
  return "low";
}

function detectGPUTier(): "high" | "mid" | "low" {
  // Run microbenchmark from V3 spec Appendix B
  // Measure: instanced draw time, texture upload, text pass
  const benchmarkMs = runMicrobenchmark();
  
  if (benchmarkMs < 5) return "high";
  if (benchmarkMs < 15) return "mid";
  return "low";
}
```

---

## 2) Touch gesture mapping

### 2.1 Gesture taxonomy
| Gesture | Action | Notes |
|---|---|---|
| Single touch drag | Pan chart | With momentum physics |
| Pinch | Zoom | Around pinch center |
| Double tap | Reset zoom / Fit all | Toggle between states |
| Long press | Activate crosshair | Follow finger while held |
| Long press + drag | Crosshair scrub | Haptic feedback on bar change |
| Two-finger pan | Scroll page (pass-through) | Don't capture; let browser scroll |
| Tap on drawing | Select drawing | Show handles |
| Tap on empty | Deselect | Clear selection |

### 2.2 Gesture recognizer
```typescript
class TouchGestureRecognizer {
  private touches: Map<number, TouchState> = new Map();
  private gestureState: GestureState = { type: "idle" };
  private longPressTimer: number | null = null;
  
  // Thresholds
  private readonly LONG_PRESS_MS = 500;
  private readonly TAP_MAX_MOVE_PX = 10;
  private readonly PINCH_THRESHOLD = 0.05;  // 5% scale change to start pinch
  
  handleTouchStart(event: TouchEvent): void {
    for (const touch of event.changedTouches) {
      this.touches.set(touch.identifier, {
        id: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        startTime: performance.now(),
        currentX: touch.clientX,
        currentY: touch.clientY,
      });
    }
    
    this.updateGestureState(event);
  }
  
  handleTouchMove(event: TouchEvent): void {
    for (const touch of event.changedTouches) {
      const state = this.touches.get(touch.identifier);
      if (state) {
        state.currentX = touch.clientX;
        state.currentY = touch.clientY;
      }
    }
    
    this.processGesture(event);
  }
  
  handleTouchEnd(event: TouchEvent): void {
    for (const touch of event.changedTouches) {
      this.touches.delete(touch.identifier);
    }
    
    this.finalizeGesture(event);
  }
  
  private updateGestureState(event: TouchEvent): void {
    const touchCount = this.touches.size;
    
    if (touchCount === 1) {
      // Start long press detection
      this.longPressTimer = window.setTimeout(() => {
        this.onLongPress();
      }, this.LONG_PRESS_MS);
      
      this.gestureState = { type: "potential_pan_or_tap" };
      
    } else if (touchCount === 2) {
      // Cancel long press, start pinch detection
      this.cancelLongPress();
      this.gestureState = { 
        type: "pinch",
        initialDistance: this.getTouchDistance(),
        initialCenter: this.getTouchCenter(),
        initialScale: 1.0,
      };
    }
  }
  
  private processGesture(event: TouchEvent): void {
    switch (this.gestureState.type) {
      case "potential_pan_or_tap":
        if (this.hasMoved(this.TAP_MAX_MOVE_PX)) {
          this.cancelLongPress();
          this.gestureState = { type: "panning" };
          this.startPan();
        }
        break;
        
      case "panning":
        this.updatePan();
        break;
        
      case "pinch":
        this.updatePinch();
        break;
        
      case "crosshair":
        this.updateCrosshair();
        break;
    }
  }
  
  private onLongPress(): void {
    this.gestureState = { type: "crosshair" };
    this.activateCrosshair();
    this.triggerHaptic("medium");
  }
  
  private triggerHaptic(intensity: "light" | "medium" | "heavy"): void {
    if ("vibrate" in navigator) {
      const duration = intensity === "light" ? 10 : intensity === "medium" ? 25 : 50;
      navigator.vibrate(duration);
    }
  }
}
```

### 2.3 Pinch zoom implementation
```typescript
interface PinchState {
  initialDistance: number;
  initialCenter: Point;
  initialScale: number;
  initialViewport: Viewport;
}

function updatePinchZoom(state: PinchState, touches: TouchState[]): ZoomDelta {
  const currentDistance = getTouchDistance(touches);
  const currentCenter = getTouchCenter(touches);
  
  // Scale factor
  const scale = currentDistance / state.initialDistance;
  
  // Zoom around pinch center
  const zoomCenter = currentCenter;
  
  // Also track pan during pinch
  const panDelta = {
    x: currentCenter.x - state.initialCenter.x,
    y: currentCenter.y - state.initialCenter.y,
  };
  
  return {
    scale,
    centerX: zoomCenter.x,
    centerY: zoomCenter.y,
    panX: panDelta.x,
    panY: panDelta.y,
  };
}
```

### 2.4 Momentum physics
```typescript
class MomentumPhysics {
  private velocity: Point = { x: 0, y: 0 };
  private lastPosition: Point | null = null;
  private lastTime: number = 0;
  
  // Physics constants (tuned to match iOS)
  private readonly FRICTION = 0.95;          // Per-frame velocity multiplier
  private readonly MIN_VELOCITY = 0.5;       // Stop threshold (px/frame)
  private readonly VELOCITY_SCALE = 0.5;     // Initial velocity dampening
  
  onDragMove(position: Point, time: number): void {
    if (this.lastPosition && this.lastTime) {
      const dt = time - this.lastTime;
      if (dt > 0) {
        this.velocity = {
          x: (position.x - this.lastPosition.x) / dt * 16,  // Normalize to 60fps
          y: (position.y - this.lastPosition.y) / dt * 16,
        };
      }
    }
    this.lastPosition = position;
    this.lastTime = time;
  }
  
  onDragEnd(): Point {
    // Return initial momentum velocity
    return {
      x: this.velocity.x * this.VELOCITY_SCALE,
      y: this.velocity.y * this.VELOCITY_SCALE,
    };
  }
  
  tick(): { delta: Point; active: boolean } {
    // Apply friction
    this.velocity.x *= this.FRICTION;
    this.velocity.y *= this.FRICTION;
    
    const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
    const active = speed > this.MIN_VELOCITY;
    
    return {
      delta: active ? { ...this.velocity } : { x: 0, y: 0 },
      active,
    };
  }
}
```

---

## 3) Mobile performance optimizations

### 3.1 Reduced rendering during idle
```typescript
class MobileRenderScheduler {
  private idleTimeout: number | null = null;
  private isIdle: boolean = false;
  private currentFps: number = 60;
  
  private readonly IDLE_DELAY_MS = 2000;
  private readonly IDLE_FPS = 10;
  private readonly ACTIVE_FPS = 60;
  
  onInteraction(): void {
    this.isIdle = false;
    this.currentFps = this.ACTIVE_FPS;
    
    // Reset idle timer
    if (this.idleTimeout) clearTimeout(this.idleTimeout);
    this.idleTimeout = window.setTimeout(() => {
      this.enterIdleMode();
    }, this.IDLE_DELAY_MS);
  }
  
  private enterIdleMode(): void {
    this.isIdle = true;
    this.currentFps = this.IDLE_FPS;
  }
  
  shouldRenderFrame(frameNumber: number): boolean {
    if (!this.isIdle) return true;
    
    // Only render every Nth frame in idle mode
    const frameSkip = Math.floor(this.ACTIVE_FPS / this.IDLE_FPS);
    return frameNumber % frameSkip === 0;
  }
}
```

### 3.2 Background/foreground handling
```typescript
class VisibilityManager {
  private isVisible: boolean = true;
  private renderer: ChartRenderer;
  
  constructor(renderer: ChartRenderer) {
    this.renderer = renderer;
    
    document.addEventListener("visibilitychange", () => {
      this.isVisible = document.visibilityState === "visible";
      this.onVisibilityChange();
    });
    
    // iOS-specific: handle page show/hide
    window.addEventListener("pagehide", () => this.onBackground());
    window.addEventListener("pageshow", () => this.onForeground());
  }
  
  private onVisibilityChange(): void {
    if (this.isVisible) {
      this.onForeground();
    } else {
      this.onBackground();
    }
  }
  
  private onBackground(): void {
    // Pause rendering entirely
    this.renderer.pause();
    
    // Release non-essential GPU resources
    this.renderer.releaseTransientResources();
  }
  
  private onForeground(): void {
    // Resume rendering
    this.renderer.resume();
    
    // Rebuild transient resources
    this.renderer.rebuildTransientResources();
    
    // Force full redraw (data may have updated)
    this.renderer.invalidateAll();
  }
}
```

### 3.3 Thermal throttling detection
```typescript
class ThermalMonitor {
  private performanceHistory: number[] = [];
  private readonly HISTORY_SIZE = 60;  // 1 second at 60fps
  private readonly THROTTLE_THRESHOLD = 1.5;  // 50% slower than baseline
  
  private baselineFrameTime: number | null = null;
  private isThrottled: boolean = false;
  
  recordFrameTime(frameTimeMs: number): void {
    this.performanceHistory.push(frameTimeMs);
    if (this.performanceHistory.length > this.HISTORY_SIZE) {
      this.performanceHistory.shift();
    }
    
    // Establish baseline from first N frames
    if (this.baselineFrameTime === null && this.performanceHistory.length >= 30) {
      this.baselineFrameTime = this.getMedian(this.performanceHistory.slice(0, 30));
    }
    
    // Detect throttling
    if (this.baselineFrameTime !== null) {
      const recentMedian = this.getMedian(this.performanceHistory.slice(-30));
      this.isThrottled = recentMedian > this.baselineFrameTime * this.THROTTLE_THRESHOLD;
    }
  }
  
  getQualityReduction(): number {
    if (!this.isThrottled) return 1.0;
    
    // Reduce quality proportionally to slowdown
    const recentMedian = this.getMedian(this.performanceHistory.slice(-30));
    const slowdownFactor = recentMedian / (this.baselineFrameTime || 16);
    
    // Return quality multiplier (0.5 - 1.0)
    return Math.max(0.5, 1.0 / slowdownFactor);
  }
  
  private getMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
}
```

### 3.4 Adaptive quality
```typescript
interface QualitySettings {
  dpr: number;
  tileSizePx: number;
  msaaEnabled: boolean;
  textQuality: "high" | "medium" | "low";
  indicatorLimit: number;
}

function computeAdaptiveQuality(
  deviceProfile: DeviceProfile,
  thermalMultiplier: number,
  batteryLevel: number | null
): QualitySettings {
  let dpr = deviceProfile.maxDpr;
  let tileSizePx = deviceProfile.tileSizePx;
  let msaaEnabled = true;
  let textQuality: "high" | "medium" | "low" = "high";
  let indicatorLimit = 50;
  
  // Apply thermal reduction
  if (thermalMultiplier < 1.0) {
    dpr = Math.max(1.0, dpr * thermalMultiplier);
    msaaEnabled = false;
    textQuality = "medium";
    indicatorLimit = Math.floor(indicatorLimit * thermalMultiplier);
  }
  
  // Apply battery reduction (if low)
  if (batteryLevel !== null && batteryLevel < 0.2) {
    dpr = Math.max(1.0, dpr * 0.75);
    msaaEnabled = false;
    textQuality = "low";
    indicatorLimit = Math.min(indicatorLimit, 20);
  }
  
  return { dpr, tileSizePx, msaaEnabled, textQuality, indicatorLimit };
}
```

---

## 4) Responsive layout system

### 4.1 Breakpoints
```typescript
const BREAKPOINTS = {
  mobile: { maxWidth: 640 },
  tablet: { minWidth: 641, maxWidth: 1024 },
  desktop: { minWidth: 1025 },
} as const;

type LayoutMode = "mobile" | "tablet" | "desktop";

function getLayoutMode(viewportWidth: number): LayoutMode {
  if (viewportWidth <= BREAKPOINTS.mobile.maxWidth) return "mobile";
  if (viewportWidth <= BREAKPOINTS.tablet.maxWidth) return "tablet";
  return "desktop";
}
```

### 4.2 Layout configurations
```typescript
interface LayoutConfig {
  // Chart area
  chartPadding: { top: number; right: number; bottom: number; left: number };
  
  // Axes
  priceAxisWidth: number;
  timeAxisHeight: number;
  priceAxisPosition: "right" | "left";
  
  // Controls
  toolbarPosition: "top" | "bottom" | "floating";
  toolbarHeight: number;
  
  // Panels
  indicatorPaneMinHeight: number;
  maxIndicatorPanes: number;
  
  // Touch
  minTouchTargetSize: number;
  
  // Menus
  menuStyle: "dropdown" | "bottom_sheet" | "fullscreen";
}

const LAYOUT_CONFIGS: Record<LayoutMode, LayoutConfig> = {
  mobile: {
    chartPadding: { top: 8, right: 8, bottom: 8, left: 8 },
    priceAxisWidth: 60,
    timeAxisHeight: 32,
    priceAxisPosition: "right",
    toolbarPosition: "bottom",
    toolbarHeight: 56,
    indicatorPaneMinHeight: 80,
    maxIndicatorPanes: 2,
    minTouchTargetSize: 44,
    menuStyle: "bottom_sheet",
  },
  tablet: {
    chartPadding: { top: 12, right: 12, bottom: 12, left: 12 },
    priceAxisWidth: 72,
    timeAxisHeight: 36,
    priceAxisPosition: "right",
    toolbarPosition: "top",
    toolbarHeight: 48,
    indicatorPaneMinHeight: 100,
    maxIndicatorPanes: 3,
    minTouchTargetSize: 44,
    menuStyle: "dropdown",
  },
  desktop: {
    chartPadding: { top: 16, right: 16, bottom: 16, left: 16 },
    priceAxisWidth: 80,
    timeAxisHeight: 40,
    priceAxisPosition: "right",
    toolbarPosition: "top",
    toolbarHeight: 44,
    indicatorPaneMinHeight: 120,
    maxIndicatorPanes: 5,
    minTouchTargetSize: 32,
    menuStyle: "dropdown",
  },
};
```

### 4.3 Touch target sizing
```typescript
// All interactive elements must meet minimum touch target size
const MIN_TOUCH_TARGET = 44;  // Apple HIG recommendation

interface TouchTarget {
  visualBounds: Rect;    // What user sees
  hitBounds: Rect;       // Actual tap target (may be larger)
}

function ensureMinTouchTarget(visualBounds: Rect): TouchTarget {
  const hitBounds = { ...visualBounds };
  
  // Expand hit bounds to minimum size if needed
  if (hitBounds.width < MIN_TOUCH_TARGET) {
    const expand = (MIN_TOUCH_TARGET - hitBounds.width) / 2;
    hitBounds.x -= expand;
    hitBounds.width = MIN_TOUCH_TARGET;
  }
  
  if (hitBounds.height < MIN_TOUCH_TARGET) {
    const expand = (MIN_TOUCH_TARGET - hitBounds.height) / 2;
    hitBounds.y -= expand;
    hitBounds.height = MIN_TOUCH_TARGET;
  }
  
  return { visualBounds, hitBounds };
}
```

---

## 5) Mobile-specific UI components

### 5.1 Bottom sheet menus
```typescript
interface BottomSheetConfig {
  snapPoints: number[];      // Heights as viewport percentages [0.3, 0.6, 0.9]
  initialSnap: number;       // Index into snapPoints
  dismissThreshold: number;  // Velocity to dismiss
  overdrag: boolean;         // Allow dragging past snap points
}

class BottomSheet {
  private currentHeight: number;
  private snapPoints: number[];
  private dragState: DragState | null = null;
  
  onDragStart(y: number): void {
    this.dragState = {
      startY: y,
      startHeight: this.currentHeight,
      velocity: 0,
    };
  }
  
  onDragMove(y: number): void {
    if (!this.dragState) return;
    
    const delta = this.dragState.startY - y;
    this.currentHeight = Math.max(0, this.dragState.startHeight + delta);
    
    // Track velocity for momentum
    this.dragState.velocity = delta;
  }
  
  onDragEnd(): void {
    if (!this.dragState) return;
    
    // Snap to nearest point or dismiss
    if (this.dragState.velocity < -this.dismissThreshold) {
      this.dismiss();
    } else {
      this.snapToNearest();
    }
    
    this.dragState = null;
  }
  
  private snapToNearest(): void {
    const viewportHeight = window.innerHeight;
    const currentPercent = this.currentHeight / viewportHeight;
    
    let nearestSnap = this.snapPoints[0];
    let nearestDist = Math.abs(currentPercent - nearestSnap);
    
    for (const snap of this.snapPoints) {
      const dist = Math.abs(currentPercent - snap);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestSnap = snap;
      }
    }
    
    this.animateTo(nearestSnap * viewportHeight);
  }
}
```

### 5.2 Crosshair tooltip (mobile)
```typescript
interface MobileCrosshairTooltip {
  // Position at top of chart, not following finger
  position: "top" | "bottom";
  
  // Compact format for small screens
  format: "compact" | "full";
  
  // Show bar data
  showOHLC: boolean;
  showVolume: boolean;
  showIndicators: boolean;
  maxIndicatorLines: number;
}

function renderMobileCrosshairTooltip(
  ctx: RenderContext,
  data: BarData,
  indicators: IndicatorValue[],
  config: MobileCrosshairTooltip
): void {
  // Fixed position tooltip (doesn't follow finger)
  const tooltipY = config.position === "top" ? 60 : ctx.height - 100;
  
  // Compact single-line format
  if (config.format === "compact") {
    const text = `O:${data.open.toFixed(2)} H:${data.high.toFixed(2)} L:${data.low.toFixed(2)} C:${data.close.toFixed(2)}`;
    renderTooltipBar(ctx, tooltipY, text);
  } else {
    // Multi-line format
    renderTooltipBox(ctx, tooltipY, data, indicators.slice(0, config.maxIndicatorLines));
  }
}
```

### 5.3 Drawing tool palette (mobile)
```typescript
// Floating action button with expandable tool palette
interface MobileDrawingPalette {
  // FAB position
  fabPosition: { x: number; y: number };
  
  // Expanded palette layout
  paletteLayout: "radial" | "horizontal" | "vertical";
  
  // Quick access tools (shown in palette)
  quickTools: DrawingType[];
  
  // All tools (shown in "more" menu)
  allTools: DrawingType[];
}

const MOBILE_DRAWING_PALETTE: MobileDrawingPalette = {
  fabPosition: { x: 24, y: -100 },  // 24px from right, 100px from bottom
  paletteLayout: "radial",
  quickTools: [
    "trend_line",
    "horizontal_line",
    "fib_retracement",
    "rectangle",
    "text",
  ],
  allTools: [/* all 30+ tools */],
};
```

---

## 6) Data loading optimizations

### 6.1 Viewport-based loading
```typescript
interface MobileDataLoadingConfig {
  // Initial load
  initialBarsVisible: number;    // Start with fewer bars on mobile
  initialLookback: number;       // Historical bars to preload
  
  // Lazy loading
  loadAheadBars: number;         // Bars to preload when panning
  loadChunkSize: number;         // Bars per request
  
  // Memory limits
  maxBarsInMemory: number;       // Evict oldest when exceeded
}

const MOBILE_DATA_CONFIG: MobileDataLoadingConfig = {
  initialBarsVisible: 100,       // vs 200 on desktop
  initialLookback: 500,          // vs 2000 on desktop
  loadAheadBars: 200,
  loadChunkSize: 500,
  maxBarsInMemory: 5000,         // vs 50000 on desktop
};
```

### 6.2 Progressive data loading
```typescript
class MobileDataLoader {
  private loadedRange: { start: number; end: number } | null = null;
  private pendingRequests: Set<string> = new Set();
  
  onViewportChange(visibleRange: { start: number; end: number }): void {
    // Check if we need to load more data
    const needsLoadLeft = !this.loadedRange || 
      visibleRange.start < this.loadedRange.start + MOBILE_DATA_CONFIG.loadAheadBars;
    const needsLoadRight = !this.loadedRange ||
      visibleRange.end > this.loadedRange.end - MOBILE_DATA_CONFIG.loadAheadBars;
    
    if (needsLoadLeft) {
      this.loadChunk("left", visibleRange.start);
    }
    if (needsLoadRight) {
      this.loadChunk("right", visibleRange.end);
    }
  }
  
  private async loadChunk(direction: "left" | "right", edge: number): Promise<void> {
    const requestId = `${direction}-${edge}`;
    if (this.pendingRequests.has(requestId)) return;
    
    this.pendingRequests.add(requestId);
    
    try {
      const range = direction === "left"
        ? { end: edge, count: MOBILE_DATA_CONFIG.loadChunkSize }
        : { start: edge, count: MOBILE_DATA_CONFIG.loadChunkSize };
      
      const data = await this.fetchData(range);
      this.mergeData(data);
      this.evictIfNeeded();
    } finally {
      this.pendingRequests.delete(requestId);
    }
  }
  
  private evictIfNeeded(): void {
    // Remove data furthest from current viewport
    while (this.totalBars > MOBILE_DATA_CONFIG.maxBarsInMemory) {
      this.evictFurthestChunk();
    }
  }
}
```

---

## 7) Orientation handling

### 7.1 Orientation change
```typescript
class OrientationManager {
  private currentOrientation: "portrait" | "landscape";
  private renderer: ChartRenderer;
  
  constructor(renderer: ChartRenderer) {
    this.renderer = renderer;
    this.currentOrientation = this.getOrientation();
    
    // Listen for orientation changes
    window.addEventListener("orientationchange", () => {
      this.handleOrientationChange();
    });
    
    // Also listen for resize (more reliable on some devices)
    window.addEventListener("resize", debounce(() => {
      const newOrientation = this.getOrientation();
      if (newOrientation !== this.currentOrientation) {
        this.handleOrientationChange();
      }
    }, 100));
  }
  
  private getOrientation(): "portrait" | "landscape" {
    return window.innerWidth > window.innerHeight ? "landscape" : "portrait";
  }
  
  private handleOrientationChange(): void {
    const newOrientation = this.getOrientation();
    this.currentOrientation = newOrientation;
    
    // Wait for layout to stabilize
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Resize canvas
        this.renderer.resize();
        
        // Adjust layout
        const layout = newOrientation === "landscape"
          ? this.getLandscapeLayout()
          : this.getPortraitLayout();
        
        this.renderer.setLayout(layout);
        
        // Invalidate all tiles (dimensions changed)
        this.renderer.invalidateAllTiles();
      });
    });
  }
  
  private getLandscapeLayout(): LayoutConfig {
    // Landscape: wider price axis, more toolbar space
    return {
      ...LAYOUT_CONFIGS.mobile,
      priceAxisWidth: 72,
      toolbarPosition: "top",
      maxIndicatorPanes: 3,
    };
  }
  
  private getPortraitLayout(): LayoutConfig {
    // Portrait: standard mobile layout
    return LAYOUT_CONFIGS.mobile;
  }
}
```

---

## 8) Platform-specific considerations

### 8.1 iOS-specific
```typescript
// iOS rubber-band scroll prevention
function preventIOSRubberBand(element: HTMLElement): void {
  element.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1) {
      e.preventDefault();
    }
  }, { passive: false });
}

// iOS safe area handling
function getIOSSafeArea(): { top: number; bottom: number; left: number; right: number } {
  const style = getComputedStyle(document.documentElement);
  return {
    top: parseInt(style.getPropertyValue("--sat") || "0"),
    bottom: parseInt(style.getPropertyValue("--sab") || "0"),
    left: parseInt(style.getPropertyValue("--sal") || "0"),
    right: parseInt(style.getPropertyValue("--sar") || "0"),
  };
}

// CSS for safe area
const IOS_SAFE_AREA_CSS = `
  :root {
    --sat: env(safe-area-inset-top);
    --sab: env(safe-area-inset-bottom);
    --sal: env(safe-area-inset-left);
    --sar: env(safe-area-inset-right);
  }
`;
```

### 8.2 Android-specific
```typescript
// Android keyboard handling
function handleAndroidKeyboard(chartContainer: HTMLElement): void {
  const originalHeight = window.innerHeight;
  
  window.addEventListener("resize", () => {
    const currentHeight = window.innerHeight;
    const keyboardVisible = currentHeight < originalHeight * 0.75;
    
    if (keyboardVisible) {
      // Keyboard opened - might need to adjust chart position
      chartContainer.style.maxHeight = `${currentHeight}px`;
    } else {
      chartContainer.style.maxHeight = "";
    }
  });
}

// Android back button handling
function handleAndroidBackButton(onBack: () => boolean): void {
  window.addEventListener("popstate", (e) => {
    const handled = onBack();
    if (!handled) {
      // Allow default back navigation
      history.back();
    } else {
      // Prevent navigation, re-push state
      history.pushState(null, "", window.location.href);
    }
  });
  
  // Push initial state
  history.pushState(null, "", window.location.href);
}
```

---

## 9) Implementation checklist

- [ ] Touch gesture recognizer (pan, pinch, long-press, double-tap)
- [ ] Momentum physics for pan
- [ ] Pinch zoom around center point
- [ ] Long-press crosshair with haptic feedback
- [ ] Device classification and profile selection
- [ ] Idle mode rendering (reduce fps when not interacting)
- [ ] Background/foreground visibility handling
- [ ] Thermal throttling detection and quality reduction
- [ ] Responsive breakpoints (mobile/tablet/desktop)
- [ ] Layout configurations per breakpoint
- [ ] Touch target size enforcement (44px minimum)
- [ ] Bottom sheet menus for mobile
- [ ] Mobile crosshair tooltip (fixed position)
- [ ] Mobile drawing tool palette (FAB + radial)
- [ ] Viewport-based progressive data loading
- [ ] Orientation change handling
- [ ] iOS safe area support
- [ ] iOS rubber-band prevention
- [ ] Android keyboard handling
- [ ] Android back button handling
