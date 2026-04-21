# Phase 3: Resource Management (CORRECTED)

## ⚠️ CRITICAL: Black Screen Issue

The black screen occurs because opaque canvases (`alpha: false`) **clear to black**, not transparent. This corrected spec fixes that issue.

---

# 06 - DPR Ceiling and Memory Accounting

## Problem

High DPR displays (4K @ 200%) create massive canvas backing stores that can cause memory issues.

## Implementation

### Step 1: Calculate Effective DPR

```typescript
const MAX_CANVAS_PIXELS = 8_000_000;  // 8 megapixels max
const MAX_DPR = 2.5;
const MIN_DPR = 1.0;

function calculateEffectiveDpr(
  cssWidth: number,
  cssHeight: number,
  deviceDpr: number = window.devicePixelRatio
): number {
  const cssPixels = cssWidth * cssHeight;
  const maxDprFromBudget = Math.sqrt(MAX_CANVAS_PIXELS / cssPixels);
  
  return Math.max(MIN_DPR, Math.min(deviceDpr, maxDprFromBudget, MAX_DPR));
}
```

### Step 2: Apply to Canvas Creation

```typescript
function createCanvas(
  cssWidth: number,
  cssHeight: number,
  effectiveDpr: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  
  // Physical size
  canvas.width = Math.round(cssWidth * effectiveDpr);
  canvas.height = Math.round(cssHeight * effectiveDpr);
  
  // CSS size
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  
  return canvas;
}
```

### Step 3: Monitor DPR Changes

```typescript
// Detect when window moves between displays
let currentDpr = window.devicePixelRatio;

function checkDprChange(): boolean {
  const newDpr = window.devicePixelRatio;
  if (newDpr !== currentDpr) {
    currentDpr = newDpr;
    return true;  // DPR changed, need to recreate canvases
  }
  return false;
}

// Check on resize
window.addEventListener('resize', () => {
  if (checkDprChange()) {
    chart.handleDprChange();
  }
});
```

---

# 08 - Opaque Layers (CORRECTED - FIXES BLACK SCREEN)

## Problem

Alpha compositing is expensive. Layers that don't need transparency should be opaque.

## ⚠️ CRITICAL RULES

1. **Opaque canvases clear to BLACK, not transparent**
2. **Must fill with background color BEFORE drawing anything**
3. **Only the FINAL composited canvas should be opaque**
4. **Intermediate layers that composite ONTO other layers need alpha**

## Correct Layer Configuration

```typescript
// CORRECT CONFIGURATION
const LAYER_CONFIG = {
  // Background layer - CAN be opaque (it's the base)
  background: {
    alpha: false,  // Opaque - will fill with background color
    clearMethod: 'fill',  // Must use fillRect, not clearRect
  },
  
  // Grid layer - NEEDS alpha (drawn on top of background)
  grid: {
    alpha: true,   // Needs transparency to show background through
    clearMethod: 'clear',  // clearRect to make transparent
  },
  
  // Series layer - NEEDS alpha (candlesticks on top of grid)
  series: {
    alpha: true,   // Needs transparency!
    clearMethod: 'clear',
  },
  
  // Pan cache - NEEDS alpha (blitted on top of other layers)
  panCache: {
    alpha: true,   // Needs transparency!
    clearMethod: 'clear',
  },
  
  // Overlay - NEEDS alpha (crosshair on top of everything)
  overlay: {
    alpha: true,
    clearMethod: 'clear',
  },
};
```

## ⚠️ WRONG vs RIGHT

### WRONG (Causes Black Screen):
```typescript
// DON'T DO THIS - Series layer as opaque
const seriesCtx = seriesCanvas.getContext('2d', { alpha: false });
seriesCtx.clearRect(0, 0, width, height);  // This stays BLACK!
// ... draw candlesticks
// When composited, black covers everything
```

### RIGHT (Correct Approach):
```typescript
// Option A: Series layer with alpha (RECOMMENDED)
const seriesCtx = seriesCanvas.getContext('2d', { alpha: true });
seriesCtx.clearRect(0, 0, width, height);  // This is transparent
// ... draw candlesticks
// When composited, candlesticks show, background shows through gaps

// Option B: If you MUST use opaque series, fill with background first
const seriesCtx = seriesCanvas.getContext('2d', { alpha: false });
seriesCtx.fillStyle = theme.background;  // '#0a0f18' or whatever
seriesCtx.fillRect(0, 0, width, height);  // Fill with background, not black
// ... draw candlesticks
// But this means you can't composite it - it must BE the final output
```

## Correct Implementation

### Layer Manager

```typescript
type LayerName = 'background' | 'grid' | 'series' | 'overlay';

interface LayerConfig {
  alpha: boolean;
  zIndex: number;
}

// CORRECT: Only background is opaque
const LAYERS: Record<LayerName, LayerConfig> = {
  background: { alpha: false, zIndex: 0 },  // Only this is opaque
  grid:       { alpha: true,  zIndex: 1 },  // Transparent
  series:     { alpha: true,  zIndex: 2 },  // Transparent
  overlay:    { alpha: true,  zIndex: 3 },  // Transparent
};

class LayerManager {
  private layers: Map<LayerName, CanvasRenderingContext2D> = new Map();
  private canvases: Map<LayerName, HTMLCanvasElement> = new Map();
  private backgroundColor: string;
  
  constructor(
    container: HTMLElement,
    width: number,
    height: number,
    dpr: number,
    backgroundColor: string = '#0a0f18'
  ) {
    this.backgroundColor = backgroundColor;
    
    for (const [name, config] of Object.entries(LAYERS)) {
      this.createLayer(name as LayerName, width, height, dpr, config);
    }
  }
  
  private createLayer(
    name: LayerName,
    width: number,
    height: number,
    dpr: number,
    config: LayerConfig
  ): void {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.zIndex = String(config.zIndex);
    canvas.style.pointerEvents = name === 'overlay' ? 'auto' : 'none';
    
    const ctx = canvas.getContext('2d', {
      alpha: config.alpha,
      desynchronized: name === 'overlay',  // Lower latency for crosshair
    })!;
    
    ctx.scale(dpr, dpr);
    
    this.canvases.set(name, canvas);
    this.layers.set(name, ctx);
  }
  
  /**
   * CRITICAL: Correct clearing for each layer type
   */
  clearLayer(name: LayerName, cssWidth: number, cssHeight: number): void {
    const ctx = this.layers.get(name)!;
    const config = LAYERS[name];
    
    if (config.alpha) {
      // Alpha layer: clearRect makes it transparent
      ctx.clearRect(0, 0, cssWidth, cssHeight);
    } else {
      // Opaque layer: fillRect with background color
      ctx.fillStyle = this.backgroundColor;
      ctx.fillRect(0, 0, cssWidth, cssHeight);
    }
  }
  
  getContext(name: LayerName): CanvasRenderingContext2D {
    return this.layers.get(name)!;
  }
  
  getCanvas(name: LayerName): HTMLCanvasElement {
    return this.canvases.get(name)!;
  }
  
  /**
   * Update background color (e.g., theme change)
   */
  setBackgroundColor(color: string): void {
    this.backgroundColor = color;
  }
}
```

### Render Loop (Correct Order)

```typescript
class ChartRenderer {
  private layers: LayerManager;
  private cssWidth: number;
  private cssHeight: number;
  
  render(): void {
    // 1. Clear all layers CORRECTLY
    this.layers.clearLayer('background', this.cssWidth, this.cssHeight);
    this.layers.clearLayer('grid', this.cssWidth, this.cssHeight);
    this.layers.clearLayer('series', this.cssWidth, this.cssHeight);
    this.layers.clearLayer('overlay', this.cssWidth, this.cssHeight);
    
    // 2. Draw background (already filled with background color from clear)
    // Can add gradient or pattern here if needed
    
    // 3. Draw grid on grid layer (transparent layer, shows background through)
    const gridCtx = this.layers.getContext('grid');
    this.drawGrid(gridCtx);
    
    // 4. Draw series on series layer (transparent, shows grid+background through)
    const seriesCtx = this.layers.getContext('series');
    this.drawCandlesticks(seriesCtx);
    
    // 5. Draw overlay (transparent, shows everything through)
    const overlayCtx = this.layers.getContext('overlay');
    this.drawCrosshair(overlayCtx);
    
    // Layers are stacked via CSS z-index, no manual compositing needed
  }
}
```

## Alternative: Single Canvas (Simpler, Also Correct)

If using a single canvas instead of multiple layers:

```typescript
class SingleCanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private backgroundColor: string;
  
  constructor(container: HTMLElement, width: number, height: number, dpr: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    
    // Single canvas CAN be opaque since it's the final output
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.ctx.scale(dpr, dpr);
    
    this.backgroundColor = '#0a0f18';
    container.appendChild(this.canvas);
  }
  
  render(): void {
    // MUST fill with background color (opaque canvas)
    this.ctx.fillStyle = this.backgroundColor;
    this.ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    
    // Draw everything on same canvas in order
    this.drawGrid(this.ctx);
    this.drawCandlesticks(this.ctx);
    this.drawCrosshair(this.ctx);
  }
}
```

## Debugging Black Screen

If you still see black screen, check these:

### Debug Step 1: Verify layers exist
```typescript
console.log('Layers:', {
  background: !!this.layers.get('background'),
  grid: !!this.layers.get('grid'),
  series: !!this.layers.get('series'),
  overlay: !!this.layers.get('overlay'),
});
```

### Debug Step 2: Verify canvas is in DOM
```typescript
console.log('Canvas in DOM:', document.querySelectorAll('canvas').length);
```

### Debug Step 3: Check layer visibility
```typescript
// Temporarily make each layer a different color
this.layers.getContext('background').fillStyle = 'red';
this.layers.getContext('background').fillRect(0, 0, 100, 100);

this.layers.getContext('grid').fillStyle = 'green';
this.layers.getContext('grid').fillRect(100, 0, 100, 100);

this.layers.getContext('series').fillStyle = 'blue';
this.layers.getContext('series').fillRect(200, 0, 100, 100);
```

### Debug Step 4: Check alpha setting
```typescript
// If you see colors in step 3, but black normally, the issue is:
// - Opaque layer being cleared with clearRect
// - Check: is series layer set to alpha: false?
const seriesCanvas = this.layers.getCanvas('series');
const ctx = seriesCanvas.getContext('2d');
console.log('Series canvas alpha:', ctx.getContextAttributes().alpha);
// Should be TRUE for series layer
```

### Debug Step 5: Check clear is being called
```typescript
clearLayer(name: LayerName, ...): void {
  console.log(`Clearing ${name}, alpha: ${LAYERS[name].alpha}`);
  // ...
}
```

## Verification Checklist

After implementing, verify:

- [ ] Background shows theme color (not black)
- [ ] Grid lines visible on top of background
- [ ] Candlesticks visible on top of grid
- [ ] Crosshair visible on top of candlesticks
- [ ] No black rectangles anywhere
- [ ] Transparent areas show layers beneath

## Common Mistakes

| Mistake | Result | Fix |
|---------|--------|-----|
| Series layer `alpha: false` + `clearRect` | Black screen | Use `alpha: true` for series |
| Forgot to call clear before drawing | Previous frame shows through | Always clear first |
| Wrong z-index order | Layers in wrong order | Check z-index values |
| Canvas not added to DOM | Nothing visible | Verify appendChild |
| DPR not applied to context | Blurry rendering | Call ctx.scale(dpr, dpr) |
| Background color undefined | Black background | Set default '#0a0f18' |

## Summary

**The key insight:**
- Only the BOTTOM layer (background) should be opaque
- All OTHER layers that composite ON TOP need `alpha: true`
- Opaque layers must be filled with `fillRect()`, never `clearRect()`
